// 帳號、行程、邀請與帳本 API（資料層：PostgreSQL／Bun.SQL，Requirement 11.1–11.3、11.7）。
// Schema 由 Migration_Runner（migrations/*.sql）建立；本模組不建立或修改 Schema。
// security-harden 的功能（邀請連結、註冊政策、收據 AI 政策與用量、安全事件與警示、密碼重設）
// 使用相同的非同步查詢與寫入交易（withWriteTx：pg_advisory_xact_lock）。
import { AI_IMAGE_LIMIT, ReceiptAiError, readLimitedBytes, validateAiImage } from './receipt-ai.js';
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { GENERIC_500, logRequestError } from './safe-log.js';
import { AI_COST_DEFAULTS, PER_USER_WINDOW_MS, quotaDecision, utcDayStart, utcMonthStart } from './ai-cost.js';
import { addParticipant, canDepart, dateRange, isValidState, myGear, normalizeParticipantName } from '../src/model.js';
import { syncMealIngredients } from '../src/ingredients.js';
import {
  RECEIPT_AI_KEY, RECEIPT_AI_POLICIES, REGISTRATION_KEY, REGISTRATION_POLICIES,
  receiptAiDecision, resolveReceiptAiPolicy, resolveRegistrationPolicy
} from './settings.js';
import { createAlertDispatcher, createSecurityEventStore, eventUsername } from './security-events.js';
import { LEDGER_LIMITS, LedgerError, buildLedger, ledgerView, readLedgerRow, refreshSnapshotNames, requestHash, validateLedgerBody } from './ledger.js';
import { isLoopbackAddress } from './config.js';
import { createSetupGuard } from './setup-guard.js';
import { pingSql } from './db/connect.js';
import { withWriteTx } from './db/tx.js';
import * as q from './db/queries.js';

const scrypt = promisify(scryptCb);
const DAY = 86400000;
const SESSION_TTL = 7 * DAY;
const INVITE_TTL = 7 * DAY;
const BODY_LIMIT = 1024 * 1024;
const COOKIE = 'ggc_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const RESERVED = new Set(['api', 'admin', 'setup', 'login', 'register', 'logout', 'demo', 'assets']);
const USERNAME = /^[a-z][a-z0-9-]{2,31}$/;
const COVER_KINDS = ['camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise'];
const STATUSES = ['planning', 'completed'];
const ROLES = ['admin', 'member'];
const CARD_LIMITS = { title: 100, destination: 100, description: 1000, note: 1000 };
const MAX_ACTIVE_INVITES = 20;
const MAX_MEMBER_INVITES = 5;
const MAX_SESSIONS_PER_USER = 20;
const MAX_AUDIT = 5000;
const MAX_CLIENT_EVENTS = 10;
const LIMITS = {
  loginUser: { max: 5, window: 15 * 60000 },
  loginClient: { max: 30, window: 15 * 60000 },
  register: { max: 20, window: 60 * 60000 },
  invitePreview: { max: 60, window: 15 * 60000 },
  // 首次管理員設定：與登入相同的每用戶端上限，通過與未通過的請求都計入（Req 9.8）
  setupClient: { max: 30, window: 15 * 60000 }
};

// `headers` is an optional array of [name, value] pairs sent with the error response (for example Retry-After).
class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; if (headers) this.headers = headers; }
}
const fail = (status, message, headers) => { throw new HttpError(status, message, headers); };

const sha256 = value => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('hex');
const TOKEN = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const participantKey = value => normalizeParticipantName(value).replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLocaleLowerCase('zh-TW');
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function json(status, data, extraHeaders) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const [key, value] of extraHeaders || []) headers.append(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}
const errorResponse = (status, message, extra) => json(status, { error: message }, extra);

// Media type check only; reads no body. JSON_Route handlers call it before the session check (Req 10.3, 10.4).
function requireJsonType(request) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') fail(415, '請以 JSON 格式送出資料。');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
// Fails closed: a malformed or impossible stored hash returns false instead of throwing (Req 2.6).
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    const salt = Buffer.from(parts[4], 'base64'), expected = Buffer.from(parts[5], 'base64');
    if (![N, r, p].every(Number.isSafeInteger) || !expected.length) return false;
    const actual = await scrypt(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validateUsername(value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) fail(400, '帳號需為 3–32 個小寫英數字或連字號，並以英文字母開頭。');
  if (RESERVED.has(value)) fail(400, '這個帳號名稱已保留，請換一個。');
  return value;
}
function validatePassword(value) {
  if (typeof value !== 'string') fail(400, '請輸入密碼。');
  const length = [...value].length;
  if (length < 12 || length > 128) fail(400, '密碼需為 12–128 個字元。');
  return value;
}
function validateName(value, role = '') {
  if (typeof value !== 'string' || typeof role !== 'string') fail(400, '請填寫名字或暱稱。');
  try { return addParticipant({ people: [] }, value, role).person; } catch (error) { fail(400, error.message); }
}
const validateDisplayName = value => validateName(value).name;

function cleanState(input) {
  if (!isPlainObject(input)) return null;
  const pick = (item, keys, optional = []) => {
    if (!isPlainObject(item)) return item;
    const out = {};
    for (const key of keys) out[key] = item[key];
    for (const key of optional) if (item[key] !== undefined) out[key] = item[key];
    return out;
  };
  const list = (value, keys, optional) => Array.isArray(value) ? value.map(item => pick(item, keys, optional)) : value;
  return {
    schema: input.schema, revision: input.revision, currentUser: input.currentUser, joined: input.joined,
    trip: pick(input.trip, ['title', 'destination', 'startDate', 'endDate', 'description', 'note']),
    people: list(input.people, ['id', 'name', 'color', 'role']),
    activities: list(input.activities, ['id', 'date', 'time', 'title', 'type', 'location', 'note', 'people', 'done'], ['vehicleIds']),
    meals: list(input.meals, ['id', 'date', 'slot', 'title', 'cookId', 'servings', 'ingredients', 'notes'], ['imageKind']),
    shopping: list(input.shopping, ['id', 'name', 'quantity', 'category', 'assignee', 'done'], ['source', 'mealIds', 'recipeRemoved']),
    gear: list(input.gear, ['id', 'name', 'quantity', 'scope', 'assignee', 'ready']),
    vehicles: list(input.vehicles, ['id', 'name', 'driver', 'seats', 'passengers', 'meeting']),
    events: list(input.events, ['id', 'text', 'at', 'actor']),
    departed: input.departed
  };
}

function validateTripText(trip) {
  for (const [key, max] of Object.entries(CARD_LIMITS)) {
    if (typeof trip[key] !== 'string') fail(400, '旅行資料格式不正確。');
    trip[key] = trip[key].trim();
    if ([...trip[key]].length > max) fail(400, `旅行欄位 ${key} 最多 ${max} 個字。`);
    // PostgreSQL TEXT 不能儲存 U+0000；先以 400 拒絕，避免寫入時失敗成 500。
    if (trip[key].includes('\u0000')) fail(400, `旅行欄位 ${key} 含有不允許的字元。`);
  }
  if (!trip.title) fail(400, '請填寫旅行名稱。');
  for (const key of ['startDate', 'endDate']) if (typeof trip[key] !== 'string') fail(400, '請填寫旅行日期。');
  if (!dateRange(trip.startDate, trip.endDate).length) fail(400, '日期需為有效日期，結束不早於開始，且最長 31 天。');
}

// The card defaults of a new (non-imported) trip from POST /api/trips; also used for the Smoke_Fixture (Req 27.11).
const NEW_TRIP_BASE = Object.freeze({ destination: '', description: '', note: '', coverKind: 'camp', status: 'planning' });

/** Display name of the Smoke_Account created by the create-smoke-account tool (Req 27.5). */
export const SMOKE_DISPLAY_NAME = 'Smoke Bot';

/**
 * The trip title rule of POST /api/trips (mergeCard / validateTripText: 1–100 characters, no U+0000), and in
 * addition no leading or trailing whitespace, so the stored title is character-for-character the string that
 * scripts/smoke.mjs compares (Req 27.5). Throws HttpError 400; returns the title unchanged.
 */
export function validateFixtureTitle(value) {
  if (typeof value !== 'string' || value === '') fail(400, '請填寫 Smoke_Fixture 行程標題。');
  if (value.trim() !== value) fail(400, 'Smoke_Fixture 行程標題不能有前後空白。');
  if ([...value].length > CARD_LIMITS.title) fail(400, `Smoke_Fixture 行程標題最多 ${CARD_LIMITS.title} 個字。`);
  if (value.includes('\u0000')) fail(400, 'Smoke_Fixture 行程標題含有不允許的字元。');
  return value;
}

function mergeCard(body, base, required) {
  const card = { ...base };
  for (const key of ['title', 'destination', 'startDate', 'endDate', 'description', 'note', 'coverKind', 'status']) {
    if (body[key] === undefined) { if (required.includes(key)) fail(400, '請填寫旅行名稱與日期。'); continue; }
    if (typeof body[key] !== 'string') fail(400, `旅行欄位 ${key} 格式不正確。`);
    card[key] = body[key];
  }
  if (!COVER_KINDS.includes(card.coverKind)) fail(400, '封面類型不正確。');
  if (!STATUSES.includes(card.status)) fail(400, '旅行狀態不正確。');
  validateTripText(card);
  return card;
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
function applyCardToState(state, card) {
  const range = dateRange(card.startDate, card.endDate);
  const offset = Math.round((Date.parse(`${card.startDate}T00:00:00Z`) - Date.parse(`${state.trip.startDate}T00:00:00Z`)) / DAY) || 0;
  for (const item of [...state.activities, ...state.meals]) {
    const shifted = offset ? addDays(item.date, offset) : item.date;
    if (!range.includes(shifted)) fail(400, '新日期範圍放不下既有行程或餐次，請先調整行程或延長日期。');
    item.date = shifted;
  }
  state.trip = { title: card.title, destination: card.destination, startDate: card.startDate, endDate: card.endDate, description: card.description, note: card.note };
}

function addUniqueParticipant(state, baseName, role) {
  for (let n = 1; n <= 100; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    const name = [...baseName].slice(0, 30 - suffix.length).join('') + suffix;
    try { return addParticipant(state, name, role); } catch (error) {
      if (!/已在小隊/.test(error.message)) fail(409, error.message);
    }
  }
  fail(409, '無法建立不重複的旅伴名稱。');
}

function detachPerson(state, personId) {
  let clearedShared = false;
  state.people = state.people.filter(p => p.id !== personId);
  for (const a of state.activities) a.people = a.people.filter(id => id !== personId);
  for (const m of state.meals) if (m.cookId === personId) m.cookId = '';
  for (const s of state.shopping) if (s.assignee === personId) s.assignee = '';
  for (const g of state.gear) {
    if (g.assignee === personId) { g.assignee = ''; if (g.scope === 'shared') { clearedShared = true; g.ready = []; } }
    g.ready = g.ready.filter(id => id !== personId);
  }
  for (const v of state.vehicles) {
    if (v.driver === personId) v.driver = '';
    v.passengers = v.passengers.filter(id => id !== personId);
  }
  state.departed = clearedShared ? [] : state.departed.filter(id => id !== personId);
  if (state.currentUser === personId) state.currentUser = state.people[0]?.id;
}

class RateLimiter {
  constructor(clock, capacity = 10000) { this.clock = clock; this.capacity = capacity; this.entries = new Map(); }
  blocked(key, { max }) {
    const entry = this.entries.get(key);
    return !!entry && entry.reset > this.clock() && entry.count >= max;
  }
  hit(key, { window }) {
    const now = this.clock();
    let entry = this.entries.get(key);
    if (!entry || entry.reset <= now) {
      this.entries.delete(key);
      if (this.entries.size >= this.capacity) {
        for (const [k, v] of this.entries) if (v.reset <= now) this.entries.delete(k);
        while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value);
      }
      entry = { count: 0, reset: now + window };
      this.entries.set(key, entry);
    }
    entry.count++;
  }
  clear(key) { this.entries.delete(key); }
  // Whole seconds until the key's window ends, rounded up and at least 1 (Req 4.5).
  retryAfter(key) {
    const entry = this.entries.get(key);
    return entry ? Math.max(1, Math.ceil((entry.reset - this.clock()) / 1000)) : 1;
  }
  // True the first time it is called for the key's current window, then false until a new window starts.
  noteOnce(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.reset <= this.clock() || entry.noted) return false;
    entry.noted = true;
    return true;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// 127.0.0.0/8、::1、::ffff:127.0.0.0/104（Req 9.1 (a)）
const isLoopbackIp = ip => isLoopbackAddress(ip);
// 經 Trusted_Proxies 轉送的請求永遠不視為 loopback 用戶端（Req 9.12）；loopback 判定以 TCP 來源 IP 為準。
function isLoopback(url, info) {
  if (info?.viaProxy) return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  const ip = info?.tcpIp !== undefined ? info.tcpIp : info?.ip;
  if (ip !== undefined) return typeof ip === 'string' && isLoopbackIp(ip);
  return true;
}

/** 組裝 ggc_session Set-Cookie 值（Req 10.3–10.5）；`url` 應為重建後的有效請求網址。 */
export const cookieHeader = (url, token, maxAge) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
const clientKey = info => (typeof info?.ip === 'string' && info.ip ? info.ip.slice(0, 64) : 'local');

/**
 * 建立帳號服務。
 *
 * @param {object} options
 * @param {{sql: import('bun').SQL, ping?: (ms?: number) => Promise<boolean>, close?: () => Promise<void>}} options.db
 *   server/db/connect.js `createDatabase` 的回傳值（或形狀相同的物件）。Schema 必須已由 Migration_Runner 建立。
 *   **連線池由呼叫端擁有**：`service.close()` 只停止服務（之後的請求回應 503），不關閉 `db`；
 *   呼叫端在 `service.close()` 之後自行 `await db.close()`。
 * @param {() => number|Date} [options.now] 測試用時鐘
 * @param {object} [options.receiptAi] server/receipt-ai.js `createReceiptAi` 的回傳值
 * @param {object} [options.setup] server/setup-guard.js 的 guard；未提供時視為 loopback 綁定
 * @param {object} [options.aiCost] AI_Cost_Config（config.js `parseConfig` 的 `aiCost`）；預設 AI_COST_DEFAULTS
 * @param {'open'|'closed'|null} [options.registrationPolicySeed] Registration_Seed（CAMPING_REGISTRATION）；只在 settings 沒有
 *   registrationPolicy 儲存值時使用，從不寫入。實際生效值為 'closed' 時 /api/register 回應 403（邀請註冊不受影響）
 * @param {'all'|'admins'|'off'|null} [options.receiptAiPolicySeed] 收據 AI 政策的啟動種子；只在 settings 沒有儲存值時使用，從不寫入
 * @param {{maxEvents?: number, maxAlerts?: number}} [options.securityEventLimits] 測試用：降低安全事件與警示的保留上限
 * @param {(line: string) => void} [options.alertLog] Security_Alert 的日誌輸出（預設 console.error）
 * @returns {Promise<{handle: Function, ping: Function, needsSetup: Function, createFirstAdmin: Function,
 *   resetPassword: Function, provisionSmokeAccount: Function, receiptAiPolicy: Function, registrationPolicy: Function, registerAlertNotifier: Function,
 *   close: () => void}>}
 */
export async function createAccountService({
  db, now, receiptAi = null, setup = null, aiCost = AI_COST_DEFAULTS, registrationPolicySeed = null, receiptAiPolicySeed = null,
  securityEventLimits = {}, alertLog = console.error
} = {}) {
  const sql = db?.sql;
  if (typeof sql !== 'function' || typeof sql.begin !== 'function') throw new TypeError('createAccountService 需要 db.sql（Bun.SQL 連線池）');
  if (registrationPolicySeed !== null && !REGISTRATION_POLICIES.includes(registrationPolicySeed)) throw new TypeError('registrationPolicySeed 必須是 open、closed 或 null');
  if (receiptAiPolicySeed !== null && !RECEIPT_AI_POLICIES.includes(receiptAiPolicySeed)) throw new TypeError('receiptAiPolicySeed 必須是 all、admins、off 或 null');
  // 及早確認 Schema 已由 Migration_Runner 建立（含 0002 的資料表）；只回報結構性問題，不含連線設定。
  try {
    await sql`SELECT 1 FROM users LIMIT 0`;
    await sql`SELECT 1 FROM settings LIMIT 0`;
  } catch (error) {
    throw new Error(`Database 無法使用或尚未套用遷移（${error?.code || error?.name || 'ERROR'}）`);
  }
  // 未提供 setup guard 時視為 loopback 綁定：Setup_Token 停用，只有 loopback 用戶端能完成首次設定。
  const setupGuard = setup || createSetupGuard({ bindAddress: '127.0.0.1' });
  const clock = () => { const value = now ? now() : Date.now(); return value instanceof Date ? value.getTime() : Number(value); };
  const iso = () => new Date(clock()).toISOString();
  const limiter = new RateLimiter(clock);
  // Every Security_Alert goes through this one dispatcher (Req 23.16). securityEventLimits lets tests lower the caps.
  const securityEvents = createSecurityEventStore(sql, clock, {
    ...(Number.isSafeInteger(securityEventLimits?.maxEvents) ? { maxEvents: securityEventLimits.maxEvents } : {}),
    ...(Number.isSafeInteger(securityEventLimits?.maxAlerts) ? { maxAlerts: securityEventLimits.maxAlerts } : {})
  });
  const alertDispatcher = createAlertDispatcher({ store: securityEvents, log: alertLog });
  securityEvents.attachDispatcher(alertDispatcher);
  const aiActive = new Map();
  let closed = false, dummyHash;
  // 每個寫入交易：BEGIN → 全域 advisory lock（等同 SQLite BEGIN IMMEDIATE）→ fn(t) → COMMIT；例外即 ROLLBACK（Req 11.3）。
  const tx = fn => withWriteTx(sql, fn);

  const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role });
  const audit = async (e, actor, action, target) => { await q.insertAudit(e, clock(), actor, action, target); await q.trimAudit(e, MAX_AUDIT); };
  const needsSetup = async (e = sql) => (await q.userCount(e)) === 0;

  // Read on every call so an admin change applies to the next request without a restart (Req 11.8).
  // The seed is a read-time fallback only and is never written (Req 11.5-11.7, 11.12).
  async function receiptAiPolicy(e = sql) {
    const row = await q.settingByKey(e, RECEIPT_AI_KEY);
    const { value, source } = resolveReceiptAiPolicy(row?.value ?? null, receiptAiPolicySeed ?? null);
    return { value, source, updatedAt: row ? new Date(row.updated_at).toISOString() : null, updatedBy: row?.updated_by ?? null };
  }
  // Registration_Policy is read per request the same way, so an admin toggle applies to the next request (Req 26.1, 26.5).
  // A stored value outside open/closed fails closed; the seed is never written (Req 26.2).
  // Invite registration never consults it (Req 26.12).
  async function registrationPolicy(e = sql) {
    const row = await q.settingByKey(e, REGISTRATION_KEY);
    const { value, source } = resolveRegistrationPolicy(row?.value ?? null, registrationPolicySeed);
    return { value, source, updatedAt: row ? new Date(row.updated_at).toISOString() : null, updatedBy: row?.updated_by ?? null };
  }
  const settingsBody = async () => ({
    receiptAiPolicy: { ...(await receiptAiPolicy()), options: RECEIPT_AI_POLICIES },
    registrationPolicy: { ...(await registrationPolicy()), options: REGISTRATION_POLICIES }
  });

  // Shared by POST /api/setup and the create-admin CLI (Req 8.5, 8.13). The write transaction re-checks the
  // user count under the advisory lock, so a concurrent creation gets 409 (Req 8.14, 9.11).
  // The password is only hashed; it is never logged or written to the audit log.
  async function createFirstAdmin(input, { auditAction = 'setup' } = {}) {
    const { username: rawUsername, displayName: rawDisplayName, password } = input ?? {};
    const username = validateUsername(rawUsername), displayName = validateDisplayName(rawDisplayName);
    const hash = await hashPassword(validatePassword(password));
    return tx(async t => {
      if ((await q.userCount(t)) !== 0) fail(409, '管理員已設定完成。');
      const id = randomUUID();
      await q.insertUser(t, id, username, displayName, 'admin', hash, clock());
      await audit(t, username, auditAction, `user:${username}`);
      return q.userById(t, id);
    });
  }

  // Local password reset for the reset-password CLI: replaces the hash and ends every session of the account.
  async function resetPassword(username, password) {
    const validUsername = validateUsername(username);
    const hash = await hashPassword(validatePassword(password));
    return tx(async t => {
      const user = await q.userByName(t, validUsername);
      if (!user || user.deleted_at !== null) fail(404, '找不到這個帳號。');
      await q.updatePassword(t, hash, user.id);
      await q.deleteUserSessions(t, user.id);
      await audit(t, 'local-cli', 'password.reset.cli', `user:${validUsername}`);
      return validUsername;
    });
  }

  // A refusal of provisionSmokeAccount: HttpError 409 with a machine-readable `reason`; the transaction rolls back.
  const SMOKE_REFUSALS = {
    no_admin: '這個 Database 還沒有管理員。請先以 create-admin 建立第一個管理員，再建立 Smoke_Test 合成帳號。',
    account_is_admin: '這個帳號名稱屬於管理員帳號，不會作為 Smoke_Test 合成帳號，也不會修改。',
    account_disabled: '這個帳號已停用，不會作為 Smoke_Test 合成帳號，也不會修改。'
  };
  const refuse = reason => { const error = new HttpError(409, SMOKE_REFUSALS[reason]); error.reason = reason; throw error; };

  // The create-smoke-account tool (Req 27.7–27.14). Validation and hashing run outside the transaction; every check
  // and write runs in one write transaction under the advisory lock. An existing member account is kept as is
  // (role, display name, password hash and sessions); when the account and the fixture both exist nothing is
  // written, not even an audit event. The password is only hashed and never logged or audited.
  // `dates` is { startDate, endDate } (scripts/smoke.mjs SMOKE_FIXTURE_DATES).
  // Returns { username, account: 'created'|'kept', fixture, fixtureStatus: 'created'|'kept' }.
  async function provisionSmokeAccount({ username, password, fixture, dates } = {}) {
    const name = validateUsername(username), title = validateFixtureTitle(fixture);
    const hash = await hashPassword(validatePassword(password)); // unused when the account exists (Req 27.9)
    const card = mergeCard({ title, startDate: dates?.startDate, endDate: dates?.endDate }, NEW_TRIP_BASE, ['title', 'startDate', 'endDate']);
    return tx(async t => {
      if ((await q.activeAdmins(t)) === 0) refuse('no_admin');
      let user = await q.userByName(t, name), account = 'kept';
      if (user && user.deleted_at !== null) refuse('account_disabled');
      if (user?.role === 'admin') refuse('account_is_admin');
      if (!user) {
        const id = randomUUID();
        await q.insertUser(t, id, name, SMOKE_DISPLAY_NAME, 'member', hash, clock());
        await audit(t, name, 'smoke.account.create', `user:${name}`);
        user = await q.userById(t, id);
        account = 'created';
      }
      let fixtureStatus = 'kept';
      // The same set GET /api/trips returns to a member account (Req 27.11, 27.12).
      if (!(await q.myTrips(t, user.id)).some(row => row.title === title)) {
        const { state, person } = newTripState(card, user.display_name);
        const tripId = randomUUID();
        await insertNewTrip(t, { id: tripId, owner: user, card, state, personId: person.id, at: clock() });
        await audit(t, name, 'smoke.fixture.create', `trip:${tripId}`);
        fixtureStatus = 'created';
      }
      return { username: name, account, fixture: title, fixtureStatus };
    });
  }

  function sessionToken(request) {
    for (const part of (request.headers.get('cookie') || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === COOKIE) {
        const value = part.slice(index + 1).trim();
        return TOKEN.test(value) ? value : null;
      }
    }
    return null;
  }
  async function currentUser(request, e = sql) {
    const token = sessionToken(request);
    return token ? (await q.sessionUser(e, sha256(token), clock())) || null : null;
  }
  const requireUser = async (request, e = sql) => (await currentUser(request, e)) || fail(401, '請先登入。');
  const requireAdmin = async (request, e = sql) => { const user = await requireUser(request, e); if (user.role !== 'admin') fail(403, '需要管理員權限。'); return user; };
  const requireExpectedUser = async (request, expectedUserId, e = sql) => {
    const user = await requireUser(request, e);
    if (expectedUserId !== undefined && (typeof expectedUserId !== 'string' || expectedUserId !== user.id)) fail(409, '登入帳號已在其他分頁變更，這份資料未儲存。');
    return user;
  };

  async function startSession(request, url, user, extra = {}) {
    const previous = sessionToken(request);
    if (previous) await q.deleteSession(sql, sha256(previous));
    const token = newToken(), at = clock(), tokenHash = sha256(token);
    await q.deleteExpiredSessions(sql, at);
    await q.insertSession(sql, tokenHash, user.id, at, at + SESSION_TTL);
    await q.trimSessions(sql, user.id, tokenHash, MAX_SESSIONS_PER_USER);
    return json(200, { user: publicUser(user), needsSetup: false, ...extra }, [['Set-Cookie', cookieHeader(url, token, SESSION_TTL / 1000)]]);
  }

  // Rate-limit refusal with Retry-After set to the longest remaining window of the blocked keys (Req 4.5).
  const limited = (keys, message) => fail(429, message, [['Retry-After', String(Math.max(...keys.map(k => limiter.retryAfter(k))))]]);

  // Persistent receipt AI quota (Req 18.3, 18.4, 18.9). The count check and the `pending` row insert run in
  // one write transaction under the advisory lock, so they are atomic across App_Server processes. A crash
  // leaves a `pending` row that still counts, which errs toward lower spending.
  const AI_UNAVAILABLE = 'AI 辨識服務暫時無法使用，請稍後再試。';
  const USAGE_RETENTION = 400 * DAY;
  async function reserveAiCall(userId, tripId) {
    try {
      return await tx(async t => {
        const at = clock();
        const userTimes = await q.usageUserTimes(t, userId, at - PER_USER_WINDOW_MS);
        const dayCount = await q.usageCountSince(t, utcDayStart(at));
        const monthCount = await q.usageCountSince(t, utcMonthStart(at));
        const decision = quotaDecision({ now: at, userTimes, dayCount, monthCount, config: aiCost });
        if (!decision.ok) fail(429, 'AI 辨識次數已達上限，請稍後再試。', [['Retry-After', String(decision.retryAfter)]]);
        const id = randomUUID();
        await q.insertUsage(t, id, at, userId, tripId, aiCost.modelId);
        await q.trimUsage(t, at - USAGE_RETENTION);
        return id;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(503, AI_UNAVAILABLE);
    }
  }
  // Settles the reserved row. A failed update is logged and does not change the response, because the call happened.
  async function settleAiCall(id, outcome, usage, request, url) {
    if (closed) return;
    const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    try { await q.settleUsage(sql, outcome, tokens(usage?.promptTokens), tokens(usage?.completionTokens), id); }
    catch (error) { logRequestError({ method: request.method, url, error }); }
  }
  const isAiTimeout = error => (error instanceof ReceiptAiError && error.status === 504) || error?.name === 'AbortError' || error?.name === 'TimeoutError';
  async function usagePeriod(start) {
    const row = await q.usageTotalsSince(sql, start);
    return { start: new Date(start).toISOString(), requests: row.requests, promptTokens: row.prompt, completionTokens: row.completion };
  }

  async function readJson(request) {
    requireJsonType(request);
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > BODY_LIMIT) fail(413, '資料太大，上限為 1 MB。');
    const chunks = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) { await reader.cancel().catch(() => {}); fail(413, '資料太大，上限為 1 MB。'); }
        chunks.push(value);
      }
    }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail(400, 'JSON 格式不正確。'); }
    if (!isPlainObject(data)) fail(400, '資料必須是 JSON 物件。');
    return data;
  }

  const capabilities = (row, user, isMember) => {
    const manage = row.owner_id === user.id || user.role === 'admin';
    return { canEdit: manage || isMember, canDelete: manage, canInvite: manage || isMember, canManage: manage };
  };
  async function tripAccess(e, user, tripId) {
    const row = ID.test(tripId) ? await q.tripById(e, tripId) : null;
    if (!row) fail(404, '找不到這趟旅行。');
    const personId = (await q.membership(e, tripId, user.id))?.person_id ?? null;
    const caps = capabilities(row, user, !!personId);
    if (!caps.canEdit) fail(404, '找不到這趟旅行。');
    return { row, personId, ...caps };
  }
  // tripAccess already 404s for accounts outside the trip; this keeps the Inviter rule explicit (Req 16.3).
  const requireInviter = access => { if (!access.canInvite) fail(404, '找不到這趟旅行。'); return access; };
  function requireRevision(access, revision) {
    if (!Number.isSafeInteger(revision)) fail(400, '缺少版本號 revision。');
    if (revision !== access.row.revision) fail(409, '旅行已被其他人更新，請重新載入後再修改。');
  }
  const ownerPersonId = async (e, row) => (await q.membership(e, row.id, row.owner_id))?.person_id ?? null;

  const summary = async (e, row, user) => {
    const isMember = row.owner_id === user.id || !!(await q.membership(e, row.id, user.id));
    const caps = capabilities(row, user, isMember);
    return {
      id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, ownerUsername: row.owner_username,
      title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date,
      description: row.description, note: row.note, coverKind: row.cover_kind, status: row.status,
      revision: row.revision, canEdit: caps.canEdit, canDelete: caps.canDelete, canInvite: caps.canInvite, canManage: caps.canManage,
      memberCount: row.people_count, isMember
    };
  };
  async function envelope(e, user, tripId) {
    const access = await tripAccess(e, user, tripId);
    const state = JSON.parse(access.row.state_json);
    const has = id => !!id && state.people.some(p => p.id === id);
    const viewer = has(access.personId) ? access.personId : await ownerPersonId(e, access.row);
    state.currentUser = has(viewer) ? viewer : state.people[0].id;
    state.revision = access.row.revision;
    state.joined = true;
    const { canEdit, canDelete, canInvite, canManage, personId } = access;
    return { trip: await summary(e, access.row, user), state, permissions: { canEdit, canDelete, canInvite, canManage, personId } };
  }

  function actorName(user, state, personId) {
    const person = personId && state.people.find(p => p.id === personId);
    return person ? person.name : `${user.display_name}（管理員）`;
  }
  function pushEvent(state, text, actor) {
    state.events = [{ id: randomUUID(), text: String(text).slice(0, 200), actor, at: iso() }, ...state.events].slice(0, 50);
  }

  async function persist(t, row, state, meta = {}) {
    const ownerId = meta.ownerId ?? row.owner_id;
    const revision = row.revision + 1;
    const anchor = (await q.membership(t, row.id, ownerId))?.person_id;
    state.revision = revision;
    state.joined = true;
    state.currentUser = state.people.some(p => p.id === anchor) ? anchor : state.people[0]?.id;
    if (!isValidState(state)) fail(400, '旅行資料格式不正確，未儲存。');
    const s = state.trip;
    const changed = await q.updateTrip(t, {
      id: row.id, expectedRevision: row.revision, ownerId, title: s.title, destination: s.destination, startDate: s.startDate, endDate: s.endDate,
      description: s.description, note: s.note, coverKind: meta.coverKind ?? row.cover_kind, status: meta.status ?? row.status,
      revision, peopleCount: state.people.length, stateJson: JSON.stringify(state), updatedAt: clock()
    });
    if (changed !== 1) fail(409, '旅行已被其他人更新，請重新載入後再修改。');
    await snapshotRemovedPeople(t, row, state);
  }
  // A person leaving the trip keeps the name they had while they still owe or are owed money; the debt itself is never moved.
  async function snapshotRemovedPeople(t, row, state) {
    const before = JSON.parse(row.state_json).people;
    const kept = new Set(state.people.map(p => p.id));
    const removed = new Set(before.filter(p => !kept.has(p.id)).map(p => p.id));
    const ledgerRow = removed.size ? await q.ledgerByTrip(t, row.id) : null;
    if (!ledgerRow) return;
    let stored;
    try { stored = readLedgerRow(ledgerRow).ledger; } catch { return; }
    const next = refreshSnapshotNames(stored, before, removed);
    await q.updateLedgerPeople(t, JSON.stringify(next), row.id, ledgerRow.revision);
  }
  async function ledgerAccess(e, user, tripId) {
    const access = await tripAccess(e, user, tripId);
    const state = JSON.parse(access.row.state_json);
    if (!access.personId || !state.people.some(p => p.id === access.personId)) fail(404, '找不到這趟旅行。');
    return { ...access, state };
  }
  function ledgerEnvelope(access, current) {
    return { ledger: ledgerView(current.revision, current.ledger, access.state.people), permissions: { canEdit: access.canEdit, canDelete: access.canDelete } };
  }
  function runSync(state) {
    try { syncMealIngredients(state); } catch (error) { fail(400, error.message); }
  }
  // The trip state of a new trip, shared by POST /api/trips and provisionSmokeAccount (Req 27.11): an empty state
  // (or the cleaned legacy `baseState`) → applyCardToState → the creator joins as 這趟的召集人 → revision 1 →
  // meal ingredient sync → creation event → isValidState. Throws HttpError 400/409. Returns { state, person }.
  function newTripState(card, displayName, baseState = null) {
    let state = baseState || { schema: 1, revision: 0, currentUser: '', joined: true, trip: { ...card }, people: [], activities: [], meals: [], shopping: [], gear: [], vehicles: [], events: [], departed: [] };
    applyCardToState(state, card);
    const added = addUniqueParticipant(state, displayName, '這趟的召集人');
    state = added.state;
    state.currentUser = added.person.id;
    state.revision = 1;
    runSync(state);
    pushEvent(state, baseState ? '匯入了旅行手冊' : '建立了這本旅行手冊', added.person.name);
    if (!isValidState(state)) fail(400, '旅行資料格式不正確。');
    return { state, person: added.person };
  }
  // Inserts the trip row and the owner's membership inside the caller's write transaction `t`.
  async function insertNewTrip(t, { id, owner, card, state, personId, at }) {
    await q.insertTrip(t, {
      id, ownerId: owner.id, title: card.title, destination: card.destination, startDate: card.startDate, endDate: card.endDate,
      description: card.description, note: card.note, coverKind: card.coverKind, status: card.status,
      revision: 1, peopleCount: state.people.length, stateJson: JSON.stringify(state), createdAt: at, updatedAt: at
    });
    await q.insertMember(t, id, owner.id, personId, at);
  }
  const DENY_REMOVAL = '受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。';
  const DENY_PACKING = '只能變更自己的行前準備。';
  // A row someone bought stays a manual row once a member unticks it, so a later recipe edit cannot prune it.
  const retainPurchased = (old, item) => { if (old?.done && !item.done && item.source === 'meal') item.source = 'manual'; };
  // Invited members may add and edit, but never remove items, rewrite other accounts' identities or pack for others.
  async function guardCollaborator(t, tripId, stored, next, me) {
    const oldShopping = new Map(stored.shopping.map(x => [x.id, x]));
    for (const item of next.shopping) {
      const old = oldShopping.get(item.id);
      if (old && old.source !== 'meal' && item.source === 'meal') fail(403, DENY_REMOVAL);
      retainPurchased(old, item);
    }
    for (const key of ['people', 'activities', 'meals', 'gear', 'vehicles']) {
      const kept = new Set(next[key].map(item => item.id));
      if (stored[key].some(item => !kept.has(item.id))) fail(403, DENY_REMOVAL);
    }
    const bound = new Set((await q.membersOf(t, tripId)).map(b => b.person_id));
    for (const person of next.people) {
      const old = stored.people.find(p => p.id === person.id);
      if (old && bound.has(person.id) && person.id !== me && ['name', 'role', 'color'].some(k => old[k] !== person[k])) fail(403, '只能修改自己的旅伴資料。');
    }
    const oldGear = new Map(stored.gear.map(g => [g.id, g]));
    for (const g of next.gear) {
      const old = oldGear.get(g.id);
      const reset = !old || old.assignee !== g.assignee || old.scope !== g.scope;
      const before = new Set(old?.ready || []), after = new Set(g.ready);
      if (g.ready.some(id => id !== me && !before.has(id))) fail(403, DENY_PACKING);
      if (!reset && [...before].some(id => id !== me && !after.has(id))) fail(403, DENY_PACKING);
    }
    const departedBefore = new Set(stored.departed);
    const newlyDeparted = next.departed.filter(id => !departedBefore.has(id));
    if (newlyDeparted.some(id => id !== me)) fail(403, DENY_PACKING);
    if (newlyDeparted.length && !canDepart({ ...next, currentUser: me })) fail(400, '個人裝備尚未準備完成，或仍有共用裝備未分配。');
  }
  // Only rows the server's own recipe sync would prune (untouched, unbought, generated) may disappear.
  function guardShoppingRemoval(stored, synced) {
    const sim = structuredClone({ ...stored, meals: synced.meals });
    try { syncMealIngredients(sim); } catch { sim.shopping = stored.shopping; }
    const simKept = new Set(sim.shopping.map(s => s.id)), finalKept = new Set(synced.shopping.map(s => s.id));
    for (const item of stored.shopping) {
      if (finalKept.has(item.id)) continue;
      const autoPruned = item.source === 'meal' && !item.done && !simKept.has(item.id);
      if (!autoPruned) fail(403, DENY_REMOVAL);
    }
  }
  // Returns { invite, row } for an unexpired, unrevoked token whose creator is still an Inviter and whose
  // trip is live. Used tokens are returned too; callers check invite.used_at.
  async function resolveInvite(e, token) {
    const invite = TOKEN.test(token) ? await q.inviteForUse(e, sha256(token), clock()) : null;
    const row = invite ? await q.tripById(e, invite.trip_id) : null;
    if (!row) fail(404, '邀請連結無效或已過期。');
    return { invite, row };
  }
  const inTrip = async (e, row, userId) => row.owner_id === userId || !!(await q.membership(e, row.id, userId));
  // Valid_Invite: resolvable and not yet used.
  async function usableInvite(e, token) {
    const found = await resolveInvite(e, token);
    if (found.invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
    return found;
  }
  // Must run inside tx with the membership insert; the used_at guard makes a second consumption fail.
  async function consumeInTx(t, invite, userId) {
    if ((await q.consumeInvite(t, clock(), userId, invite.token_hash)) !== 1) fail(404, '邀請連結無效或已過期。');
  }
  async function addMemberInTx(t, row, userId, name, role) {
    let added;
    try { added = addParticipant(JSON.parse(row.state_json), name, role); } catch (error) {
      fail(/已在小隊|額滿/.test(error.message) ? 409 : 400, error.message);
    }
    await q.insertMember(t, row.id, userId, added.person.id, clock());
    pushEvent(added.state, `${added.person.name} 加入了小隊`, added.person.name);
    await persist(t, row, added.state);
  }

  async function softDeleteTrip(request, tripId, adminOnly) {
    requireJsonType(request);
    if (adminOnly) await requireAdmin(request); else await requireUser(request);
    const body = await readJson(request);
    if (typeof body.expectedUserId !== 'string') fail(400, '缺少目前登入帳號 expectedUserId。');
    await tx(async t => {
      const user = await requireExpectedUser(request, body.expectedUserId, t);
      if (adminOnly && user.role !== 'admin') fail(403, '需要管理員權限。');
      const row = ID.test(tripId) ? await q.anyTripById(t, tripId) : null;
      if (!row) fail(404, '找不到這趟旅行。');
      const deleted = !!(await q.tripDeletion(t, tripId));
      if (!capabilities(row, user, false).canDelete) {
        if (!deleted && await q.membership(t, tripId, user.id)) fail(403, '受邀旅伴可以編輯旅行，但只有主辦人或管理員可以刪除。');
        fail(404, '找不到這趟旅行。');
      }
      if (deleted) fail(409, '這趟旅行已刪除。');
      if (typeof body.confirmTitle !== 'string' || body.confirmTitle !== row.title) fail(400, '請輸入要刪除的旅行名稱以確認。');
      requireRevision({ row }, body.revision);
      const at = clock();
      await q.insertTripDeletion(t, tripId, user.id, at);
      await q.revokeTripInvites(t, at, tripId);
      await audit(t, user.username, 'trip.delete', `trip:${tripId}`);
    });
    return json(200, { ok: true });
  }

  const routes = {
    async getSession(request) {
      const user = await currentUser(request);
      const setupPending = await needsSetup();
      return json(200, {
        user: user ? publicUser(user) : null, needsSetup: setupPending, setupTokenRequired: setupPending && setupGuard.required,
        // webSetup stays true: the web first-admin flow (with Setup_Token off loopback) is the only deployment mode.
        webSetup: true, registrationOpen: (await registrationPolicy()).value === 'open', inviteRegistration: !setupPending
      });
    },

    async setup(request, url, info) {
      // 1. 限速：先判斷再計數，通過與未通過的請求都計入；達上限時不驗證 token（Req 9.8、9.9）
      const client = clientKey(info);
      const limitKey = `setup:client:${client}`;
      if (limiter.blocked(limitKey, LIMITS.setupClient)) fail(429, '設定嘗試太多次，請 15 分鐘後再試。');
      limiter.hit(limitKey, LIMITS.setupClient);
      // 2. 已有使用者 → 409，不論來源或 token（Req 9.6）
      if (!(await needsSetup())) fail(409, '管理員已設定完成。');
      // 讀取 body 以取得 setupToken；格式錯誤延後到授權通過後才回報，未授權者一律 403
      let body = {}, bodyError = null;
      try { body = await readJson(request); } catch (error) { if (!(error instanceof HttpError)) throw error; bodyError = error; }
      // 3. 授權（Req 9.1、9.12）：本機 Host + loopback TCP IP 且非經代理，或 Setup_Token 相符
      const candidate = typeof body.setupToken === 'string' ? body.setupToken : '';
      if (!isLoopback(url, info) && !setupGuard.verify(candidate)) {
        const reason = !setupGuard.required ? 'non_loopback' : candidate ? 'token_mismatch' : 'missing_token';
        // 稽核只記原因類別與來源 IP，絕不記錄提交的 token（Req 9.4）
        await audit(sql, 'anonymous', 'setup.denied', `reason:${reason} ip:${client}`);
        fail(403, setupGuard.required ? '首次管理員設定需要有效的設定碼。' : '首次管理員設定只能在本機進行。');
      }
      // 4. 輸入驗證失敗 → 400／415，Setup_Token 不被消耗（Req 9.10）
      if (bodyError) throw bodyError;
      // 5. 交易內再次檢查使用者數，並行請求只會建立一個管理員（Req 9.11）
      const user = await createFirstAdmin(body);
      // 6. Setup_Token 失效（Req 9.5）
      setupGuard.consume();
      return startSession(request, url, user);
    },

    async register(request, url, info) {
      // Checked before the limiter and before the body, so a closed site neither reads input nor spends the bucket.
      if ((await registrationPolicy()).value !== 'open') fail(403, '目前不開放公開註冊，請使用旅行邀請連結建立帳號。');
      const key = `register:${clientKey(info)}`;
      if (limiter.blocked(key, LIMITS.register)) limited([key], '註冊嘗試太多次，請稍後再試。');
      limiter.hit(key, LIMITS.register);
      // needsSetup stays ahead of the 415: the register-bucket property expects 409 for a
      // body-less request before the first admin exists. No session can exist in that state.
      if (await needsSetup()) fail(409, '請先完成管理員設定。');
      requireJsonType(request);
      const body = await readJson(request);
      const username = validateUsername(body.username), displayName = validateDisplayName(body.displayName);
      validatePassword(body.password);
      if (await q.userByName(sql, username)) fail(409, '這個帳號名稱已被使用。');
      const hash = await hashPassword(body.password);
      const user = await tx(async t => {
        if (await q.userByName(t, username)) fail(409, '這個帳號名稱已被使用。');
        const id = randomUUID();
        await q.insertUser(t, id, username, displayName, 'member', hash, clock());
        await audit(t, username, 'register', `user:${username}`);
        return q.userById(t, id);
      });
      return startSession(request, url, user);
    },

    // Every exit that starts no Session records exactly one Failed_Login_Event (Req 23.1), except that
    // rate_limited is recorded once per blocked key per window (Req 23.5). The password never reaches record().
    async login(request, url, info) {
      const client = clientKey(info);
      const record = async (reason, rawUsername) => {
        try {
          await securityEvents.recordFailedLogin({ at: clock(), client, username: eventUsername(rawUsername), reason });
        } catch (error) {
          // A failed write keeps the login response unchanged (Req 23.15); only the error name is logged.
          logRequestError({ method: request.method, url, error });
        }
      };
      let body;
      try { body = await readJson(request); } catch (error) {
        if (error instanceof HttpError) await record('invalid_input', null);
        throw error;
      }
      if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
        await record('invalid_input', body?.username);
        fail(400, '請輸入帳號與密碼。');
      }
      const username = body.username.trim().toLowerCase().slice(0, 64);
      const userKey = `login:user:${username}`, clientLimitKey = `login:client:${client}`;
      const blockedKeys = [[userKey, LIMITS.loginUser], [clientLimitKey, LIMITS.loginClient]].filter(([k, l]) => limiter.blocked(k, l)).map(([k]) => k);
      if (blockedKeys.length) {
        // map, not some: every blocked key is marked noted in this window, so each key records at most once.
        if (blockedKeys.map(k => limiter.noteOnce(k)).includes(true)) await record('rate_limited', body.username);
        limited(blockedKeys, '登入失敗次數太多，請 15 分鐘後再試。');
      }
      // Every stored username matches USERNAME, so anything else (including U+0000, which PostgreSQL TEXT
      // cannot hold) is an unknown account without a query; the dummy hash below keeps the timing the same.
      const user = USERNAME.test(username) ? await q.userByName(sql, username) : null;
      const password = body.password.length <= 1024 ? body.password : '';
      dummyHash ||= await hashPassword(newToken());
      const ok = await verifyPassword(password, user?.password_hash || dummyHash);
      if (!ok || !user || user.deleted_at !== null || !password) {
        limiter.hit(userKey, LIMITS.loginUser);
        limiter.hit(clientLimitKey, LIMITS.loginClient);
        await record(user && user.deleted_at !== null && ok && password ? 'deleted_account' : 'bad_credentials', body.username);
        fail(401, '帳號或密碼不正確。');
      }
      limiter.clear(userKey);
      await audit(sql, user.username, 'login', `user:${user.username}`);
      return startSession(request, url, user);
    },

    async logout(request, url) {
      const token = sessionToken(request);
      if (token) await q.deleteSession(sql, sha256(token));
      return json(200, { ok: true }, [['Set-Cookie', cookieHeader(url, '', 0)]]);
    },

    async listTrips(request) {
      const user = await requireUser(request);
      const rows = user.role === 'admin' ? await q.allTrips(sql) : await q.myTrips(sql, user.id);
      const trips = [];
      for (const row of rows) trips.push(await summary(sql, row, user));
      return json(200, { trips });
    },

    async createTrip(request) {
      requireJsonType(request);
      const user = await requireUser(request);
      const body = await readJson(request);
      const legacy = body.legacyState !== undefined;
      let state = legacy ? cleanState(body.legacyState) : null;
      if (legacy && (!state || !isValidState(state))) fail(400, '匯入的旅行資料格式不正確。');
      const base = legacy ? { ...state.trip, coverKind: 'camp', status: 'planning' } : NEW_TRIP_BASE;
      const card = mergeCard(body, base, legacy ? [] : ['title', 'startDate', 'endDate']);
      const created = newTripState(card, user.display_name, state);
      const id = randomUUID(), at = clock();
      await tx(async t => {
        if ((await requireExpectedUser(request, body.expectedUserId, t)).id !== user.id) fail(401, '請先登入。');
        await insertNewTrip(t, { id, owner: user, card, state: created.state, personId: created.person.id, at });
        await audit(t, user.username, 'trip.create', `trip:${id}`);
      });
      return json(201, { trip: await summary(sql, await q.tripById(sql, id), user) });
    },

    async getTrip(request, url, info, [tripId]) {
      return json(200, await envelope(sql, await requireUser(request), tripId));
    },

    async putTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      await tx(async t => {
        user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = await tripAccess(t, user, tripId);
        requireRevision(access, body.revision);
        const stored = JSON.parse(access.row.state_json);
        const next = cleanState(body.state);
        if (!next || !Array.isArray(next.people) || !next.people.length) fail(400, '旅行資料格式不正確。');
        next.revision = access.row.revision;
        next.joined = true;
        next.currentUser = next.people[0]?.id;
        if (!isValidState(next)) fail(400, '旅行資料格式不正確。');
        for (const binding of await q.membersOf(t, tripId)) {
          const person = next.people.find(p => p.id === binding.person_id);
          if (!person) fail(409, '已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。');
          const checked = validateName(person.name, person.role);
          person.name = checked.name;
          person.role = normalizeParticipantName(person.role);
          if (next.people.some(p => p.id !== person.id && participantKey(p.name) === participantKey(person.name))) fail(409, '這個名字已在小隊中，請使用不同暱稱。');
        }
        validateTripText(next.trip);
        if (!access.canDelete) await guardCollaborator(t, tripId, stored, next, access.personId);
        const actor = actorName(user, next, access.personId);
        const known = new Set(stored.events.map(ev => ev.id));
        const fresh = next.events.filter(ev => !known.has(ev.id)).slice(0, MAX_CLIENT_EVENTS)
          .map(ev => ({ id: randomUUID(), text: ev.text.slice(0, 200), actor, at: iso() }));
        next.events = [...fresh, ...stored.events].slice(0, 50);
        if (!fresh.length) pushEvent(next, '更新了旅行手冊', actor);
        runSync(next);
        if (!access.canDelete) guardShoppingRemoval(stored, next);
        await persist(t, access.row, next);
        await audit(t, user.username, 'trip.update', `trip:${tripId}`);
      });
      return json(200, await envelope(sql, user, tripId));
    },

    async patchTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      await tx(async t => {
        user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = await tripAccess(t, user, tripId);
        requireRevision(access, body.revision);
        const state = JSON.parse(access.row.state_json);
        const card = mergeCard(body, { ...state.trip, coverKind: access.row.cover_kind, status: access.row.status }, []);
        applyCardToState(state, card);
        pushEvent(state, '更新了旅行設定', actorName(user, state, access.personId));
        await persist(t, access.row, state, { coverKind: card.coverKind, status: card.status });
        await audit(t, user.username, 'trip.meta', `trip:${tripId}`);
      });
      return json(200, await envelope(sql, user, tripId));
    },

    async checkTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      if (!['shopping', 'gear', 'depart'].includes(body.kind) || typeof body.checked !== 'boolean') fail(400, '勾選資料不正確。');
      await tx(async t => {
        user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = await tripAccess(t, user, tripId);
        requireRevision(access, body.revision);
        const state = JSON.parse(access.row.state_json);
        const me = access.personId && state.people.some(p => p.id === access.personId) ? access.personId : null;
        const actor = actorName(user, state, me);
        if (body.kind === 'shopping') {
          const item = typeof body.id === 'string' && state.shopping.find(s => s.id === body.id);
          if (!item) fail(404, '找不到這個採買品項。');
          const old = { ...item };
          item.done = body.checked;
          if (!access.canDelete) retainPurchased(old, item);
          pushEvent(state, `${body.checked ? '買好了' : '取消已買'}：${item.name}`, actor);
        } else {
          if (!me) fail(403, '你不是這趟旅行的旅伴。');
          state.currentUser = me;
          if (body.kind === 'gear') {
            const item = typeof body.id === 'string' && state.gear.find(g => g.id === body.id);
            if (!item) fail(404, '找不到這個裝備。');
            if (!myGear(state, me).some(g => g.id === item.id)) fail(403, '只能勾選自己的個人裝備或負責的共用裝備。');
            item.ready = body.checked ? [...new Set([...item.ready, me])] : item.ready.filter(id => id !== me);
            if (!body.checked) state.departed = state.departed.filter(id => id !== me);
            pushEvent(state, `${body.checked ? '準備好了' : '取消準備'}：${item.name}`, actor);
          } else {
            if (body.checked) {
              if (!canDepart(state)) fail(400, '個人裝備尚未準備完成，或仍有共用裝備未分配。');
              if (!state.departed.includes(me)) state.departed = [...state.departed, me];
            } else state.departed = state.departed.filter(id => id !== me);
            pushEvent(state, body.checked ? '準備出發了' : '取消出發', actor);
          }
        }
        await persist(t, access.row, state);
        await audit(t, user.username, `trip.check.${body.kind}`, `trip:${tripId}`);
      });
      return json(200, await envelope(sql, user, tripId));
    },

    async createInvite(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      const token = newToken(), id = randomUUID(), at = clock(), expiresAt = at + INVITE_TTL;
      await tx(async t => {
        user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = requireInviter(await tripAccess(t, user, tripId));
        if ((await q.activeInvites(t, tripId, at)) >= MAX_ACTIVE_INVITES) fail(409, `每趟旅行最多 ${MAX_ACTIVE_INVITES} 個有效邀請連結。`);
        if (!access.canManage && (await q.activeInvitesByUser(t, tripId, user.id, at)) >= MAX_MEMBER_INVITES) {
          fail(409, `每位旅伴在每趟旅行最多 ${MAX_MEMBER_INVITES} 個有效邀請連結。`);
        }
        await q.insertInvite(t, id, sha256(token), tripId, user.id, at, expiresAt);
        await audit(t, user.username, 'invite.create', `trip:${tripId}`);
      });
      return json(201, { id, token, urlPath: `/invite/${token}`, expiresAt: new Date(expiresAt).toISOString() });
    },

    // Invite_List (Req 19.1–19.7): managers see every Active_Invite, members only their own.
    async listInvites(request, url, info, [tripId]) {
      const user = await requireUser(request);
      const access = requireInviter(await tripAccess(sql, user, tripId));
      const at = clock();
      const rows = access.canManage ? await q.listTripInvites(sql, tripId, at) : await q.listTripInvitesBy(sql, tripId, at, user.id);
      return json(200, { invites: rows.map(r => ({
        id: r.id, creatorName: r.creator_name,
        createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString()
      })) });
    },

    async getInvite(request, url, info, [token]) {
      const user = await requireUser(request);
      const { invite, row } = await resolveInvite(sql, token);
      const alreadyMember = await inTrip(sql, row, user.id);
      if (!alreadyMember && invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
      return json(200, { title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date, alreadyMember });
    },

    // Signed-out preview (Req 15): rate-limited before the lookup, no session read, no writes.
    async invitePreview(request, url, info, [token]) {
      const key = `invite-preview:${clientKey(info)}`;
      if (limiter.blocked(key, LIMITS.invitePreview)) limited([key], '查看邀請的次數太多，請稍後再試。');
      limiter.hit(key, LIMITS.invitePreview);
      const { invite, row } = await usableInvite(sql, token);
      return json(200, { title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date, inviterName: invite.inviter_name });
    },

    // Per-link revoke by (tripId, inviteId) only (Req 18).
    async revokeInvite(request, url, info, [tripId, inviteId]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      await tx(async t => {
        user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = requireInviter(await tripAccess(t, user, tripId));
        const invite = ID.test(inviteId) ? await q.activeInviteById(t, inviteId, tripId, clock()) : null;
        if (!invite) fail(404, '邀請連結無效或已過期。');
        if (invite.created_by !== user.id && !access.canManage) fail(403, '只有建立連結的人、主辦人或管理員可以撤銷邀請。');
        await q.revokeInviteById(t, clock(), inviteId, tripId);
        await audit(t, user.username, 'invite.revoke', `trip:${tripId}`);
      });
      return json(200, { revoked: true });
    },

    async joinInvite(request, url, info, [token]) {
      requireJsonType(request);
      let user = await requireUser(request);
      const body = await readJson(request);
      if (typeof body.name !== 'string' || (body.role !== undefined && typeof body.role !== 'string')) fail(400, '請填寫名字或暱稱。');
      const tripId = await tx(async t => {
        user = await requireUser(request, t);
        const { invite, row } = await resolveInvite(t, token);
        if (await inTrip(t, row, user.id)) return row.id;
        if (invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
        await addMemberInTx(t, row, user.id, body.name, body.role ?? '');
        await consumeInTx(t, invite, user.id);
        await audit(t, user.username, 'invite.join', `trip:${row.id}`);
        return row.id;
      });
      return json(200, { tripId });
    },

    // Signed-out account creation that joins the invite's trip in one transaction (Req 14).
    // Shares the register bucket; no Registration_Policy check, so it works when public sign-up is closed.
    async inviteRegister(request, url, info, [token]) {
      const key = `register:${clientKey(info)}`;
      if (limiter.blocked(key, LIMITS.register)) limited([key], '註冊嘗試太多次，請稍後再試。');
      limiter.hit(key, LIMITS.register);
      requireJsonType(request);
      if (await needsSetup()) fail(409, '請先完成管理員設定。');
      const body = await readJson(request);
      const username = validateUsername(body.username), displayName = validateDisplayName(body.displayName);
      validatePassword(body.password);
      const name = body.name ?? displayName, role = body.role ?? '';
      if (typeof name !== 'string' || typeof role !== 'string') fail(400, '請填寫名字或暱稱。');
      await usableInvite(sql, token); // cheap 404 before the expensive hash
      if (await q.userByName(sql, username)) fail(409, '這個帳號名稱已被使用。');
      const hash = await hashPassword(body.password);
      const { user, tripId } = await tx(async t => {
        if (await q.userByName(t, username)) fail(409, '這個帳號名稱已被使用。');
        // Re-check: the invite may have expired, been used, or its trip deleted while hashing.
        const { invite, row } = await usableInvite(t, token);
        const id = randomUUID();
        await q.insertUser(t, id, username, displayName, 'member', hash, clock());
        await addMemberInTx(t, row, id, name, role);
        await consumeInTx(t, invite, id);
        await audit(t, username, 'register.invite', `user:${username}`);
        await audit(t, username, 'invite.join', `trip:${row.id}`);
        return { user: await q.userById(t, id), tripId: row.id };
      });
      return startSession(request, url, user, { tripId });
    },

    async adminUsers(request) {
      await requireAdmin(request);
      return json(200, { users: (await q.listUsers(sql)).map(u => ({ ...publicUser(u), deleted: u.deleted_at !== null, tripCount: u.trip_count })) });
    },

    async adminPatchUser(request, url, info, [userId]) {
      requireJsonType(request);
      await requireAdmin(request);
      const body = await readJson(request);
      const user = await tx(async t => {
        const admin = await requireAdmin(request, t);
        const target = ID.test(userId) ? await q.userById(t, userId) : null;
        if (!target) fail(404, '找不到這個帳號。');
        if (target.deleted_at !== null) fail(409, '這個帳號已刪除。');
        const displayName = body.displayName === undefined ? target.display_name : validateDisplayName(body.displayName);
        const role = body.role === undefined ? target.role : body.role;
        if (!ROLES.includes(role)) fail(400, '角色必須是 admin 或 member。');
        if (target.role === 'admin' && role !== 'admin') {
          if (target.id === admin.id) fail(403, '不能移除自己的管理員權限。');
          if ((await q.activeAdmins(t)) <= 1) fail(409, '至少需要保留一位管理員。');
        }
        await q.updateUser(t, displayName, role, target.id);
        // Demotion: revoke links for trips where the account is neither owner nor member (Req 16.9).
        if (target.role === 'admin' && role === 'member') await q.revokeInvitesWithoutRights(t, clock(), target.id);
        await audit(t, admin.username, 'user.update', `user:${target.username}`);
        return q.userById(t, target.id);
      });
      return json(200, { user: { ...publicUser(user), deleted: false } });
    },

    async adminDeleteUser(request, url, info, [userId]) {
      requireJsonType(request);
      await requireAdmin(request);
      const body = await readJson(request);
      await tx(async t => {
        const admin = await requireAdmin(request, t);
        const target = ID.test(userId) ? await q.userById(t, userId) : null;
        if (!target) fail(404, '找不到這個帳號。');
        if (target.deleted_at !== null) fail(409, '這個帳號已刪除。');
        if (body.confirmUsername !== target.username) fail(400, '請輸入要刪除的帳號名稱以確認。');
        if (target.id === admin.id) fail(403, '不能刪除自己的帳號。');
        if (target.role === 'admin' && (await q.activeAdmins(t)) <= 1) fail(409, '至少需要保留一位管理員。');
        const at = clock();
        await q.softDelete(t, at, target.id);
        await q.deleteUserSessions(t, target.id);
        // Every invite the account created is revoked, which covers each trip_members row removed below (Req 16.7).
        await q.revokeInvitesBy(t, at, target.id);
        const touched = new Map();
        const load = async tripId => {
          if (!touched.has(tripId)) { const row = await q.anyTripById(t, tripId); touched.set(tripId, { row, state: JSON.parse(row.state_json), ownerId: row.owner_id }); }
          return touched.get(tripId);
        };
        for (const { trip_id, person_id } of await q.tripsOfMember(t, target.id)) {
          detachPerson((await load(trip_id)).state, person_id);
          await q.deleteMember(t, trip_id, target.id);
        }
        for (const { id } of await q.ownedTrips(t, target.id)) {
          const entry = await load(id);
          if (!(await q.membership(t, id, admin.id))) {
            const added = addUniqueParticipant(entry.state, admin.display_name, '接手的主辦人');
            entry.state = added.state;
            await q.insertMember(t, id, admin.id, added.person.id, at);
          }
          entry.ownerId = admin.id;
        }
        for (const [tripId, entry] of touched) {
          pushEvent(entry.state, '有旅伴帳號已移除，相關分工已解除綁定', `${admin.display_name}（管理員）`);
          await persist(t, entry.row, entry.state, { ownerId: entry.ownerId });
          await audit(t, admin.username, 'trip.reassign', `trip:${tripId}`);
        }
        await audit(t, admin.username, 'user.delete', `user:${target.username}`);
      });
      return json(200, { ok: true });
    },

    async getReceiptAi(request, url, info, [tripId]) {
      const user = await requireUser(request), access = await ledgerAccess(sql, user, tripId);
      if (!access.canEdit) fail(403, '需要旅行編輯權限才能辨識收據。');
      const keyEnabled = receiptAi?.status?.enabled === true;
      const decision = receiptAiDecision({ policy: (await receiptAiPolicy()).value, role: user.role, canEdit: true, keyEnabled });
      if (decision === 'allow') return json(200, receiptAi.status);
      return json(200, { enabled: false, provider: 'OpenAI', modelId: '', maxImageBytes: AI_IMAGE_LIMIT, disabledReason: decision === 'unconfigured' ? 'unconfigured' : 'policy' });
    },
    async recognizeReceiptAi(request, url, info, [tripId]) {
      const expected = request.headers.get('x-camping-user-id');
      if (!expected) { await requireUser(request); fail(400, '缺少預期登入帳號。'); }
      // The policy is read fresh each time, so a change made while the upload or recognition
      // is in flight is honored at the next authorize() call (Req 11.2, 11.3, 11.8).
      const checkPolicy = async user => {
        const decision = receiptAiDecision({ policy: (await receiptAiPolicy()).value, role: user.role, canEdit: true, keyEnabled: true });
        if (decision === 'off') fail(503, 'AI 辨識已由管理員關閉。');
        if (decision === 'admins-only') fail(403, '目前只有管理員可以使用 AI 辨識。');
      };
      const authorize = async ({ policy = true } = {}) => {
        const user = await requireExpectedUser(request, expected), access = await ledgerAccess(sql, user, tripId);
        if (!access.canEdit) fail(403, '需要旅行編輯權限才能辨識收據。');
        if (policy) await checkPolicy(user);
        return user;
      };
      const user = await authorize({ policy: false });
      if (request.headers.get('x-receipt-consent') !== 'openai-v1') fail(400, '請先同意將這張收據照片送到 OpenAI。');
      await checkPolicy(user);
      if (!receiptAi?.status?.enabled) fail(503, 'AI 辨識尚未設定，請聯絡管理員。');
      const type = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!['image/jpeg', 'image/png'].includes(type)) fail(415, '請傳送 JPEG 或 PNG 圖片。');
      if (Number(request.headers.get('content-length')) > AI_IMAGE_LIMIT) fail(413, 'AI 圖片超過 3.5 MiB。');
      // Concurrency stays in memory (Req 18.8); the per-user, UTC day, and UTC month counts live in the Database.
      if (aiActive.has(user.id) || aiActive.size >= 2) fail(429, 'AI 辨識次數或同時執行數已達上限，請稍後再試。');
      const controller = new AbortController();
      aiActive.set(user.id, controller);
      const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(70000)]);
      try {
        const bytes = await readLimitedBytes(request, AI_IMAGE_LIMIT, signal);
        validateAiImage(bytes, type);
        await authorize();
        if (signal.aborted) fail(408, '已取消這次辨識。');
        // Counted only after the policy allows and the image passes, right before the OpenAI call (Req 18.3, 18.12).
        const reservation = await reserveAiCall(user.id, tripId);
        let usage = null, result;
        try {
          result = await receiptAi.recognize(bytes, type, { signal, onUsage: u => { usage = u; } });
          await settleAiCall(reservation, 'success', usage, request, url);
        } catch (error) {
          await settleAiCall(reservation, isAiTimeout(error) ? 'timeout' : 'error', usage, request, url);
          throw error;
        }
        if (closed || signal.aborted) fail(408, '已取消這次辨識。');
        // PBN re-check; a refusal here keeps the settled usage row because the call was made (Req 11.8, 18.13).
        await authorize();
        return json(200, result);
      } finally { aiActive.delete(user.id); }
    },

    async getLedger(request, url, info, [tripId]) {
      const access = await ledgerAccess(sql, await requireUser(request), tripId);
      return json(200, ledgerEnvelope(access, readLedgerRow(await q.ledgerByTrip(sql, tripId))));
    },

    async putLedger(request, url, info, [tripId]) {
      requireJsonType(request);
      await requireUser(request);
      const body = await readJson(request);
      validateLedgerBody(body);
      const hash = requestHash(body);
      const result = await tx(async t => {
        const user = await requireExpectedUser(request, body.expectedUserId, t);
        const access = await ledgerAccess(t, user, tripId);
        const row = await q.ledgerByTrip(t, tripId);
        const current = readLedgerRow(row);
        const seenRequest = current.requests.find(r => r.id === body.requestId);
        if (seenRequest) {
          if (seenRequest.userId !== user.id || seenRequest.hash !== hash) fail(409, '這個請求編號已用於其他內容，未儲存；請重新載入後再試。');
          return ledgerEnvelope(access, current);
        }
        if (body.revision !== current.revision) fail(409, '帳本已被其他人更新，你的草稿仍保留；請重新載入後再儲存。');
        const ledger = buildLedger(body, { stored: current.ledger, state: access.state, canDelete: access.canDelete });
        const requests = [{ id: body.requestId, userId: user.id, hash }, ...current.requests].slice(0, LEDGER_LIMITS.requests);
        const at = clock();
        if (!row) await q.insertLedger(t, tripId, JSON.stringify(ledger), JSON.stringify(requests), user.id, at);
        else if ((await q.updateLedger(t, JSON.stringify(ledger), JSON.stringify(requests), user.id, at, tripId, current.revision)) !== 1) fail(409, '帳本已被其他人更新，你的草稿仍保留；請重新載入後再儲存。');
        await audit(t, user.username, 'trip.ledger', `trip:${tripId}`);
        return ledgerEnvelope(access, readLedgerRow(await q.ledgerByTrip(t, tripId)));
      });
      return json(200, result);
    },

    deleteTrip(request, url, info, [tripId]) { return softDeleteTrip(request, tripId, false); },
    adminDeleteTrip(request, url, info, [tripId]) { return softDeleteTrip(request, tripId, true); },

    async adminAudit(request) {
      await requireAdmin(request);
      return json(200, { events: (await q.listAudit(sql)).map(e => ({ at: new Date(e.at).toISOString(), actor: e.actor, action: e.action, target: e.target })) });
    },

    async adminSettings(request) {
      await requireAdmin(request);
      return json(200, await settingsBody());
    },

    // Receipt AI usage for the current UTC day and month plus the configured limits (Req 18.6).
    // `pending` rows count as requests with their recorded tokens (0).
    async adminReceiptAiUsage(request) {
      await requireAdmin(request);
      const at = clock();
      let day, month;
      try { day = await usagePeriod(utcDayStart(at)); month = await usagePeriod(utcMonthStart(at)); }
      catch { fail(503, AI_UNAVAILABLE); }
      return json(200, {
        day, month,
        limits: { perUser: aiCost.perUser, perUserWindowMinutes: PER_USER_WINDOW_MS / 60000, daily: aiCost.daily, monthly: aiCost.monthly },
        model: { id: aiCost.modelId, imageDetail: aiCost.imageDetail, maxCompletionTokens: aiCost.maxCompletionTokens }
      });
    },

    // Unacknowledged Security_Alerts newest first and the 200 most recent Failed_Login_Events (Req 23.8, 23.11, 23.12).
    async adminSecurity(request) {
      await requireAdmin(request);
      const isoAt = ms => new Date(ms).toISOString();
      const [unacknowledged, alerts, events] = [await securityEvents.unacknowledgedCount(), await securityEvents.listAlerts(), await securityEvents.listEvents()];
      return json(200, {
        unacknowledged,
        alerts: alerts.map(a => ({
          id: a.id, at: isoAt(a.at), kind: a.kind, username: a.username, client: a.client, count: a.count,
          windowStart: isoAt(a.windowStart), windowEnd: isoAt(a.windowEnd)
        })),
        events: events.map(e => ({ at: isoAt(e.at), username: e.username, client: e.client, reason: e.reason }))
      });
    },

    // The UPDATE only matches an unacknowledged alert, so an unknown, malformed, or repeated ID gets 404
    // and the rollback leaves no audit row (Req 23.10, 23.14).
    async adminAcknowledgeAlert(request, url, info, [alertId]) {
      requireJsonType(request);
      await requireAdmin(request);
      await readJson(request);
      const unacknowledged = await tx(async t => {
        const admin = await requireAdmin(request, t);
        if (!(await securityEvents.acknowledge(alertId, admin.username, clock(), t))) fail(404, '找不到這個警示，或已經確認過。');
        await audit(t, admin.username, 'security.alert.ack', `alert:${alertId}`);
        return securityEvents.unacknowledgedCount(t);
      });
      return json(200, { acknowledged: true, unacknowledged });
    },

    async adminPatchSettings(request) {
      requireJsonType(request);
      await requireAdmin(request);
      const body = await readJson(request);
      // Validate every present key before writing anything, so an invalid field leaves both settings untouched (Req 26.7).
      const hasReceipt = Object.hasOwn(body, 'receiptAiPolicy');
      const hasRegistration = Object.hasOwn(body, 'registrationPolicy');
      if (!hasReceipt && !hasRegistration) fail(400, '請至少提供一項設定。');
      if (hasReceipt && !RECEIPT_AI_POLICIES.includes(body.receiptAiPolicy)) fail(400, '收據 AI 政策必須是 all、admins 或 off。');
      if (hasRegistration && !REGISTRATION_POLICIES.includes(body.registrationPolicy)) fail(400, '公開註冊政策必須是 open 或 closed。');
      // Only the keys present are written; each gets its own audit row (Req 26.4, 26.8).
      await tx(async t => {
        const admin = await requireAdmin(request, t);
        if (hasReceipt) {
          await q.upsertSetting(t, RECEIPT_AI_KEY, body.receiptAiPolicy, clock(), admin.username);
          await audit(t, admin.username, 'settings.receipt-ai', `receiptAiPolicy:${body.receiptAiPolicy}`);
        }
        if (hasRegistration) {
          await q.upsertSetting(t, REGISTRATION_KEY, body.registrationPolicy, clock(), admin.username);
          await audit(t, admin.username, 'settings.registration', `registrationPolicy:${body.registrationPolicy}`);
        }
      });
      return json(200, await settingsBody());
    }
  };

  const table = [
    [/^\/api\/session$/, { GET: routes.getSession }],
    [/^\/api\/setup$/, { POST: routes.setup }],
    [/^\/api\/login$/, { POST: routes.login }],
    [/^\/api\/register$/, { POST: routes.register }],
    [/^\/api\/logout$/, { POST: routes.logout }],
    [/^\/api\/trips$/, { GET: routes.listTrips, POST: routes.createTrip }],
    [/^\/api\/trips\/([^/]+)$/, { GET: routes.getTrip, PUT: routes.putTrip, PATCH: routes.patchTrip }],
    [/^\/api\/trips\/([^/]+)\/check$/, { POST: routes.checkTrip }],
    [/^\/api\/trips\/([^/]+)\/ledger$/, { GET: routes.getLedger, PUT: routes.putLedger }],
    [/^\/api\/trips\/([^/]+)\/receipt-ai$/, { GET: routes.getReceiptAi, POST: routes.recognizeReceiptAi }],
    [/^\/api\/trips\/([^/]+)\/invites$/, { GET: routes.listInvites, POST: routes.createInvite }],
    [/^\/api\/trips\/([^/]+)\/invites\/([^/]+)\/revoke$/, { POST: routes.revokeInvite }],
    [/^\/api\/trips\/([^/]+)\/delete$/, { POST: routes.deleteTrip }],
    [/^\/api\/invites\/([^/]+)$/, { GET: routes.getInvite }],
    [/^\/api\/invites\/([^/]+)\/join$/, { POST: routes.joinInvite }],
    [/^\/api\/invites\/([^/]+)\/preview$/, { GET: routes.invitePreview }],
    [/^\/api\/invites\/([^/]+)\/register$/, { POST: routes.inviteRegister }],
    [/^\/api\/admin\/users$/, { GET: routes.adminUsers }],
    [/^\/api\/admin\/users\/([^/]+)$/, { PATCH: routes.adminPatchUser }],
    [/^\/api\/admin\/users\/([^/]+)\/delete$/, { POST: routes.adminDeleteUser }],
    [/^\/api\/admin\/trips\/([^/]+)\/delete$/, { POST: routes.adminDeleteTrip }],
    [/^\/api\/admin\/audit$/, { GET: routes.adminAudit }],
    [/^\/api\/admin\/settings$/, { GET: routes.adminSettings, PATCH: routes.adminPatchSettings }],
    [/^\/api\/admin\/receipt-ai-usage$/, { GET: routes.adminReceiptAiUsage }],
    [/^\/api\/admin\/security$/, { GET: routes.adminSecurity }],
    [/^\/api\/admin\/security\/alerts\/([^/]+)\/acknowledge$/, { POST: routes.adminAcknowledgeAlert }]
  ];

  async function handle(request, info = {}) {
    let url;
    try { url = new URL(request.url); } catch { return null; }
    // HTTP 處理器以 resolveClient 重建的有效網址（協定可能來自 Trusted_Proxies 的 X-Forwarded-Proto），
    // 用於 Origin 比對與 Cookie Secure 判斷（Req 9.12、10.1、10.5）。路徑一律取自原始請求。
    if (info?.url instanceof URL && info.url.pathname === url.pathname) url = new URL(info.url.href);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
    try {
      if (closed) fail(503, '服務已關閉。');
      // Every OPTIONS to the API, known path or not, gets 405 with no handler and no cookie (Req 12.3, 12.4).
      if (request.method === 'OPTIONS') return errorResponse(405, '不支援這個操作。');
      for (const [pattern, methods] of table) {
        const match = url.pathname.match(pattern);
        if (!match) continue;
        const route = methods[request.method];
        if (!route) return errorResponse(405, '不支援這個操作。', [['Allow', Object.keys(methods).join(', ')]]);
        if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) fail(403, '請求來源不被允許。');
        if (request.method !== 'GET' && request.headers.get('sec-fetch-site') === 'cross-site') fail(403, '不接受跨站請求。');
        let params;
        try { params = match.slice(1).map(decodeURIComponent); } catch { fail(400, '網址格式不正確。'); }
        return await route(request, url, info || {}, params);
      }
      fail(404, '找不到這個 API。');
    } catch (error) {
      if (error instanceof HttpError || error instanceof LedgerError || error instanceof ReceiptAiError) return errorResponse(error.status, error.message, error.headers);
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return errorResponse(408, '辨識已取消或逾時，不會自動重送。');
      // Unknown errors: one safe log line (time, method, path, error name) and the fixed generic body (Req 19.1, 19.3).
      logRequestError({ method: request.method, url, error });
      return errorResponse(500, GENERIC_500);
    }
  }

  return {
    handle,
    // 資料庫存活檢查（/healthz 使用）；已關閉或查詢失敗時回傳 false，絕不拋出。
    async ping(ms = 2000) {
      if (closed) return false;
      try { return typeof db.ping === 'function' ? (await db.ping(ms)) === true : await pingSql(sql, ms); } catch { return false; }
    },
    needsSetup: () => needsSetup(),
    createFirstAdmin,
    resetPassword,
    // create-smoke-account（scripts/create-smoke-account.mjs，Req 27）。
    provisionSmokeAccount,
    // { value, source: 'default'|'seed'|'stored', updatedAt, updatedBy }；serve.mjs 啟動摘要使用。
    receiptAiPolicy: () => receiptAiPolicy(),
    // 同上形狀的實際生效 Registration_Policy；serve.mjs 啟動摘要與測試使用（Req 26.17）。
    registrationPolicy: () => registrationPolicy(),
    // A future notifier (for example a LINE webhook) attaches here without touching alert detection (Req 23.16).
    registerAlertNotifier(notifier) { alertDispatcher.register(notifier); },
    // 只停止服務並中止進行中的 AI 辨識；連線池由呼叫端關閉（見上方 JSDoc）。可重複呼叫。
    close() { if (!closed) { closed = true; for (const controller of aiActive.values()) controller.abort(); aiActive.clear(); } }
  };
}

export { HttpError, RateLimiter, validateUsername, validateDisplayName, validatePassword, requireJsonType };
