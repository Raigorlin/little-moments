// Receipt AI cost control: persistent quota, usage records, admin usage view (security-hardening Requirement 18).
// Runs against a PostgreSQL Ephemeral_Database (CAMPING_TEST_DATABASE_*, tests/support/pg.js). Each world()
// starts from empty tables in this file's test schema; the tests run in order, so a finished world is never reused.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { useTestDatabase, resetTables, serviceDb, testQuery } from './support/pg.js';
import { createReceiptAi, normalizeAiReceipt, ReceiptAiError, AI_IMAGE_LIMIT } from '../server/receipt-ai.js';
import { AI_COST_DEFAULTS, utcDayStart, utcMonthStart, nextUtcDayStart, nextUtcMonthStart } from '../server/ai-cost.js';
import { seed } from '../src/model.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=', 'base64');
const receipt = () => normalizeAiReceipt({ currency: 'TWD', store: '測試商店', date: '2026-11-04', total: '100', items: [{ title: '鮮奶', quantity: '2', unitPrice: '50', amount: '100', category: '食材／蛋奶', uncertain: false, warning: '' }], warnings: [] });
const envelope = (usage) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ currency: 'TWD', store: '店', date: '2026-11-04', total: '100', items: [{ title: '鮮奶', quantity: '1', unitPrice: '100', amount: '100', category: '食材／蛋奶', uncertain: false, warning: '' }], warnings: [] }) } }], ...(usage ? { usage } : {}) });
// Built from fragments so the secret scanner does not flag a literal in this file.
const FAKE_KEY = ['s', 'k-'].join('') + 'test-only-' + 'x'.repeat(24);
const base = 'http://localhost:5181';
const MIN = 60000, HOUR = 60 * MIN, WINDOW = 15 * MIN;
const PASSWORD = 'Only-Test-Password-2026';
const db = useTestDatabase();

// A fake provider whose behavior is replaced per call through `next`.
function fakeProvider() {
  const p = {
    calls: 0,
    next: async () => receipt(),
    status: { enabled: true, provider: 'OpenAI', modelId: 'gpt-6-luna', maxImageBytes: AI_IMAGE_LIMIT },
    async recognize(bytes, type, opts) { p.calls++; return p.next(opts); }
  };
  return p;
}

const cookieOf = res => res.headers.get('set-cookie').split(';')[0];

// Admin (setup) and member (registered), each with an own trip. `clock.t` drives the service clock.
async function world({ receiptAi, aiCost = AI_COST_DEFAULTS, clock }) {
  await resetTables(db.sql);
  const open = (opts = {}) => createAccountService({ db: serviceDb(db.sql), now: () => clock.t, receiptAi, aiCost, ...opts });
  let service = await open();
  const call = (path, { method = 'GET', cookie = '', body, headers = {} } = {}) => service.handle(new Request(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { Origin: base } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
  }));
  const setup = await call('/api/setup', { method: 'POST', body: { username: 'cost-admin', displayName: '管理員', password: PASSWORD } });
  expect(setup.status).toBe(200);
  const admin = { cookie: cookieOf(setup), user: (await setup.json()).user };
  const reg = await call('/api/register', { method: 'POST', body: { username: 'cost-member', displayName: '成員', password: PASSWORD } });
  expect(reg.status).toBe(200);
  const member = { cookie: cookieOf(reg), user: (await reg.json()).user };
  for (const who of [admin, member]) {
    const tr = await call('/api/trips', { method: 'POST', cookie: who.cookie, body: { legacyState: seed() } });
    expect(tr.status).toBe(201);
    who.trip = (await tr.json()).trip;
  }
  const users = { admin, member };
  const w = {
    users, call,
    get service() { return service; },
    send: who => call(`/api/trips/${users[who].trip.id}/receipt-ai`, { method: 'POST', cookie: users[who].cookie, body: png, headers: { 'Content-Type': 'image/png', 'x-camping-user-id': users[who].user.id, 'x-receipt-consent': 'openai-v1' } }),
    setPolicy: async value => { const r = await call('/api/admin/settings', { method: 'PATCH', cookie: admin.cookie, body: { receiptAiPolicy: value } }); expect(r.status).toBe(200); },
    usage: async () => { const r = await call('/api/admin/receipt-ai-usage', { cookie: admin.cookie }); return { status: r.status, body: await r.json() }; },
    reopen: async (opts = {}) => { service.close(); service = await open(opts); },
    close: () => service.close()
  };
  return w;
}
// Rows in call order: at, then id for calls in the same millisecond (SQLite used rowid).
const rows = () => testQuery(db.sql, 'SELECT * FROM receipt_ai_usage ORDER BY at, id');
const clearUsage = () => db.sql`DELETE FROM receipt_ai_usage`;

// ---------------------------------------------------------------------------------------------
// Property 23 setup: one file-backed service reused across runs; usage rows cleared per run.
const CREATED = Date.UTC(2026, 2, 30, 0, 0, 0); // 2026-03-30; every run stays well inside the 7-day session TTL.
const P23_COST = Object.freeze({ ...AI_COST_DEFAULTS, perUser: 3, daily: 5, monthly: 8 });
let p23, p23Provider;
const p23Clock = { t: CREATED };
beforeAll(async () => {
  p23Provider = fakeProvider();
  p23 = await world({ receiptAi: p23Provider, aiCost: P23_COST, clock: p23Clock });
}, 60_000);
afterAll(() => { p23?.close(); });

// Reference model: earliest moment at which all three limits fit, independent of server/ai-cost.js.
function modelDecision(times, who, t, cfg) {
  const all = [...times.admin, ...times.member];
  const userRecent = times[who].filter(x => x > t - WINDOW).sort((a, b) => a - b);
  const waits = [];
  if (userRecent.length >= cfg.perUser) waits.push(userRecent[userRecent.length - cfg.perUser] + WINDOW - t);
  if (all.filter(x => x >= utcDayStart(t)).length >= cfg.daily) waits.push(nextUtcDayStart(t) - t);
  if (all.filter(x => x >= utcMonthStart(t)).length >= cfg.monthly) waits.push(nextUtcMonthStart(t) - t);
  return waits.length ? { ok: false, retryAfter: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) } : { ok: true };
}

const stepArb = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('recognize'), who: fc.constantFrom('admin', 'member') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('advance'), ms: fc.oneof(fc.integer({ min: 0, max: 2 * MIN }), fc.integer({ min: 0, max: 20 * MIN }), fc.integer({ min: 0, max: 2 * HOUR })) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('policy'), value: fc.constantFrom('all', 'admins', 'off') }) }
);
// Starts between 2026-03-30 12:00 and 2026-03-31 23:59 UTC so runs cross both the UTC day and the UTC month.
const startArb = fc.oneof(fc.integer({ min: CREATED + 12 * HOUR, max: CREATED + 48 * HOUR - 1 }), fc.integer({ min: CREATED + 48 * HOUR - 30 * MIN, max: CREATED + 48 * HOUR - 1 }));

// Feature: security-hardening, Property 23: Receipt AI calls follow the persistent quota model
test('Property 23: receipt AI calls follow the persistent quota model', async () => {
  await fc.assert(fc.asyncProperty(startArb, fc.array(stepArb, { minLength: 1, maxLength: 20 }), async (start, steps) => {
    await clearUsage();
    p23Clock.t = start;
    await p23.setPolicy('all');
    let policy = 'all';
    const times = { admin: [], member: [] };
    p23Provider.calls = 0;
    p23Provider.next = async () => receipt();
    for (const step of steps) {
      if (step.kind === 'advance') { p23Clock.t += step.ms; continue; }
      if (step.kind === 'policy') { await p23.setPolicy(step.value); policy = step.value; continue; }
      const before = p23Provider.calls;
      const res = await p23.send(step.who);
      if (policy === 'off') { expect(res.status).toBe(503); expect(p23Provider.calls).toBe(before); continue; }
      if (policy === 'admins' && step.who === 'member') { expect(res.status).toBe(403); expect(p23Provider.calls).toBe(before); continue; }
      const expected = modelDecision(times, step.who, p23Clock.t, P23_COST);
      if (expected.ok) {
        expect(res.status).toBe(200);
        expect(p23Provider.calls).toBe(before + 1);
        times[step.who].push(p23Clock.t);
      } else {
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe('AI 辨識次數已達上限，請稍後再試。');
        expect(res.headers.get('retry-after')).toBe(String(expected.retryAfter));
        expect(p23Provider.calls).toBe(before);
      }
    }
    const stored = await testQuery(db.sql, 'SELECT user_id, at, outcome FROM receipt_ai_usage ORDER BY at, id');
    expect(stored.length).toBe(times.admin.length + times.member.length);
    expect(stored.length).toBe(p23Provider.calls);
    expect(stored.every(r => r.outcome === 'success')).toBe(true);
    expect(stored.filter(r => r.user_id === p23.users.member.user.id).map(r => r.at)).toEqual(times.member);
  }), { numRuns: 40 });
});

// ---------------------------------------------------------------------------------------------
// Feature: security-hardening, Property 24: Each OpenAI call leaves exactly one usage record
const outcomeArb = fc.oneof(
  fc.record({ kind: fc.constant('success-usage'), prompt: fc.nat(100000), completion: fc.nat(16000) }),
  fc.constant({ kind: 'success-no-usage' }),
  fc.record({ kind: fc.constant('success-malformed'), prompt: fc.constantFrom('7', -1, 3.5, null, Number.NaN), completion: fc.constantFrom('9', -2, 1.25, undefined) }),
  fc.record({ kind: fc.constant('error'), prompt: fc.option(fc.nat(5000), { nil: undefined }) }),
  fc.constantFrom({ kind: 'timeout-504' }, { kind: 'timeout-dom' })
);
const expectedRow = o => {
  switch (o.kind) {
    case 'success-usage': return { outcome: 'success', prompt_tokens: o.prompt, completion_tokens: o.completion, status: 200 };
    case 'success-no-usage': case 'success-malformed': return { outcome: 'success', prompt_tokens: 0, completion_tokens: 0, status: 200 };
    case 'error': return { outcome: 'error', prompt_tokens: o.prompt ?? 0, completion_tokens: 0, status: 502 };
    case 'timeout-504': return { outcome: 'timeout', prompt_tokens: 0, completion_tokens: 0, status: 504 };
    case 'timeout-dom': return { outcome: 'timeout', prompt_tokens: 0, completion_tokens: 0, status: 408 };
  }
};
const behave = o => async ({ onUsage }) => {
  switch (o.kind) {
    case 'success-usage': onUsage({ promptTokens: o.prompt, completionTokens: o.completion }); return receipt();
    case 'success-no-usage': return receipt();
    case 'success-malformed': onUsage({ promptTokens: o.prompt, completionTokens: o.completion }); return receipt();
    case 'error': if (o.prompt !== undefined) onUsage({ promptTokens: o.prompt, completionTokens: 0 }); throw new ReceiptAiError(502, 'AI 回傳格式不正確。');
    case 'timeout-504': throw new ReceiptAiError(504, 'AI 辨識逾時。');
    case 'timeout-dom': throw new DOMException('slow', 'TimeoutError');
  }
};

test('Property 24: each OpenAI call leaves exactly one usage record', async () => {
  const provider = fakeProvider(), clock = { t: CREATED };
  const w = await world({ receiptAi: provider, aiCost: { ...AI_COST_DEFAULTS, perUser: 100, daily: 10000, monthly: 100000 }, clock });
  try {
    await fc.assert(fc.asyncProperty(fc.array(outcomeArb, { minLength: 1, maxLength: 8 }), async outcomes => {
      await clearUsage();
      provider.calls = 0;
      for (const o of outcomes) {
        clock.t += 1000;
        provider.next = behave(o);
        const res = await w.send('member');
        expect(res.status).toBe(expectedRow(o).status);
      }
      const stored = await testQuery(db.sql, 'SELECT outcome, prompt_tokens, completion_tokens, model_id, user_id FROM receipt_ai_usage ORDER BY at, id');
      expect(stored.length).toBe(provider.calls);
      expect(stored.length).toBe(outcomes.length);
      expect(stored.map(({ outcome, prompt_tokens, completion_tokens }) => ({ outcome, prompt_tokens, completion_tokens })))
        .toEqual(outcomes.map(o => { const { status, ...row } = expectedRow(o); return row; }));
      expect(stored.every(r => r.model_id === AI_COST_DEFAULTS.modelId && r.user_id === w.users.member.user.id)).toBe(true);
    }), { numRuns: 40 });
  } finally { w.close(); }
}, 120_000);

// ---------------------------------------------------------------------------------------------
// Examples

test('counts survive closing and reopening the service', async () => {
  const provider = fakeProvider(), clock = { t: CREATED };
  const w = await world({ receiptAi: provider, aiCost: { ...AI_COST_DEFAULTS, perUser: 2, daily: 3, monthly: 10 }, clock });
  try {
    expect((await w.send('member')).status).toBe(200);
    expect((await w.send('member')).status).toBe(200);
    await w.reopen();
    const blocked = await w.send('member');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBe(15 * 60);
    expect((await w.send('admin')).status).toBe(200);
    await w.reopen();
    clock.t += WINDOW + 1; // per-user window has passed, but the UTC day count (3) stays at the limit
    const daily = await w.send('member');
    expect(daily.status).toBe(429);
    expect(Number(daily.headers.get('retry-after'))).toBe(Math.ceil((nextUtcDayStart(clock.t) - clock.t) / 1000));
    expect(provider.calls).toBe(3);
    expect((await rows()).length).toBe(3);
  } finally { w.close(); }
});

test('503 without a provider call when the usage table cannot be read or written', async () => {
  const provider = fakeProvider(), clock = { t: CREATED };
  const w = await world({ receiptAi: provider, clock });
  try {
    expect((await w.send('member')).status).toBe(200);
    // Make the usage table unreadable: renamed away and restored afterwards (fixed names, test schema only).
    await db.sql`ALTER TABLE receipt_ai_usage RENAME TO receipt_ai_usage_offline`;
    try {
      const res = await w.send('member');
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('AI 辨識服務暫時無法使用，請稍後再試。');
      expect(provider.calls).toBe(1);
      expect((await w.usage()).status).toBe(503);
    } finally {
      await db.sql`ALTER TABLE receipt_ai_usage_offline RENAME TO receipt_ai_usage`;
    }
  } finally { w.close(); }
});

test('policy off and admins refuse before the quota and change no count', async () => {
  const provider = fakeProvider(), clock = { t: CREATED };
  const w = await world({ receiptAi: provider, aiCost: { ...AI_COST_DEFAULTS, perUser: 1, daily: 2, monthly: 2 }, clock });
  try {
    expect((await w.send('member')).status).toBe(200);
    // The member's per-user quota is exhausted, but the policy answers first.
    await w.setPolicy('admins');
    expect((await w.send('member')).status).toBe(403);
    await w.setPolicy('off');
    expect((await w.send('member')).status).toBe(503);
    expect((await w.send('admin')).status).toBe(503);
    expect((await rows()).length).toBe(1);
    // Refusals did not consume the day count: the admin still gets the last daily slot.
    await w.setPolicy('all');
    expect((await w.send('admin')).status).toBe(200);
    expect((await w.send('admin')).status).toBe(429);
    expect(provider.calls).toBe(2);
    expect((await rows()).length).toBe(2);
  } finally { w.close(); }
});

test('a policy change during the call refuses the result but keeps the usage row', async () => {
  const provider = fakeProvider(), clock = { t: CREATED };
  const w = await world({ receiptAi: provider, clock });
  try {
    provider.next = async ({ onUsage }) => { onUsage({ promptTokens: 321, completionTokens: 12 }); await w.setPolicy('off'); return receipt(); };
    const res = await w.send('member');
    expect(res.status).toBe(503);
    const stored = (await rows());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ outcome: 'success', prompt_tokens: 321, completion_tokens: 12, user_id: w.users.member.user.id, trip_id: w.users.member.trip.id });
  } finally { w.close(); }
});

test('configured model, detail, and token cap reach the OpenAI request body; one call, no retry', async () => {
  const cost = Object.freeze({ ...AI_COST_DEFAULTS, modelId: 'gpt-cost-test', imageDetail: 'low', maxCompletionTokens: 777 });
  const bodies = [];
  let reply = () => Response.json(envelope({ prompt_tokens: 850, completion_tokens: 64 }));
  const receiptAi = createReceiptAi({ env: { CAMPING_OPENAI_API_KEY: FAKE_KEY }, cost, fetchImpl: async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return reply(); } });
  const clock = { t: CREATED };
  const w = await world({ receiptAi, aiCost: cost, clock });
  try {
    const status = await (await w.call(`/api/trips/${w.users.member.trip.id}/receipt-ai`, { cookie: w.users.member.cookie })).json();
    expect(status.modelId).toBe('gpt-cost-test');
    expect((await w.send('member')).status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(bodies[0].body.model).toBe('gpt-cost-test');
    expect(bodies[0].body.messages[1].content[1].image_url.detail).toBe('low');
    expect(bodies[0].body.max_completion_tokens).toBe(777);
    // A provider failure is sent once and recorded once as an error.
    reply = () => new Response('upstream failure', { status: 500 });
    clock.t += 1000;
    const failed = await w.send('member');
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(bodies).toHaveLength(2);
    const stored = (await rows());
    expect(stored.map(r => [r.outcome, r.prompt_tokens, r.completion_tokens, r.model_id])).toEqual([['success', 850, 64, 'gpt-cost-test'], ['error', 0, 0, 'gpt-cost-test']]);
  } finally { w.close(); }
});

test('admin usage route totals the current UTC day and month and shows the limits', async () => {
  const provider = fakeProvider(), clock = { t: Date.UTC(2026, 2, 31, 22, 0) };
  const cost = Object.freeze({ ...AI_COST_DEFAULTS, perUser: 7, daily: 70, monthly: 700 });
  const w = await world({ receiptAi: provider, aiCost: cost, clock });
  const at = async (t, prompt, completion) => { clock.t = t; provider.next = async ({ onUsage }) => { onUsage({ promptTokens: prompt, completionTokens: completion }); return receipt(); }; expect((await w.send('member')).status).toBe(200); };
  try {
    clock.t = Date.UTC(2026, 3, 1, 1, 0);
    const empty = await w.usage();
    expect(empty.status).toBe(200);
    expect(empty.body.day).toEqual({ start: '2026-04-01T00:00:00.000Z', requests: 0, promptTokens: 0, completionTokens: 0 });
    expect(empty.body.month).toEqual({ start: '2026-04-01T00:00:00.000Z', requests: 0, promptTokens: 0, completionTokens: 0 });
    await at(Date.UTC(2026, 2, 31, 23, 0), 1000, 100); // previous month and day: excluded
    await at(Date.UTC(2026, 3, 1, 2, 0), 10, 1);
    await at(Date.UTC(2026, 3, 3, 5, 0), 20, 2);
    await at(Date.UTC(2026, 3, 3, 6, 0), 30, 3);
    clock.t = Date.UTC(2026, 3, 3, 7, 0);
    const { status, body } = await w.usage();
    expect(status).toBe(200);
    expect(body.day).toEqual({ start: '2026-04-03T00:00:00.000Z', requests: 2, promptTokens: 50, completionTokens: 5 });
    expect(body.month).toEqual({ start: '2026-04-01T00:00:00.000Z', requests: 3, promptTokens: 60, completionTokens: 6 });
    expect(body.limits).toEqual({ perUser: 7, perUserWindowMinutes: 15, daily: 70, monthly: 700 });
    expect(body.model).toEqual({ id: cost.modelId, imageDetail: cost.imageDetail, maxCompletionTokens: cost.maxCompletionTokens });
    // Members and signed-out callers cannot read it.
    expect((await w.call('/api/admin/receipt-ai-usage', { cookie: w.users.member.cookie })).status).toBe(403);
    expect((await w.call('/api/admin/receipt-ai-usage')).status).toBe(401);
  } finally { w.close(); }
});
