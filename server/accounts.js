import { Database } from 'bun:sqlite';
import { AI_IMAGE_LIMIT, ReceiptAiError, readLimitedBytes, validateAiImage } from './receipt-ai.js';
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GENERIC_500, logRequestError } from './safe-log.js';
import { AI_COST_DEFAULTS, PER_USER_WINDOW_MS, quotaDecision, utcDayStart, utcMonthStart } from './ai-cost.js';
import { addParticipant, canDepart, dateRange, isValidState, myGear, normalizeParticipantName } from '../src/model.js';
import { syncMealIngredients } from '../src/ingredients.js';
import { RECEIPT_AI_KEY, RECEIPT_AI_POLICIES, receiptAiDecision, resolveReceiptAiPolicy } from './settings.js';
import { SECURITY_EVENTS_SCHEMA, createAlertDispatcher, createSecurityEventStore, eventUsername } from './security-events.js';
import { LEDGER_LIMITS, LEDGER_SCHEMA, LedgerError, buildLedger, ledgerView, readLedgerRow, refreshSnapshotNames, requestHash, validateLedgerBody } from './ledger.js';

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
  invitePreview: { max: 60, window: 15 * 60000 }
};
const PUBLIC_DIRS = new Set(['dist', 'public']);

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

export class PublicDbPathError extends Error {
  constructor(path) {
    super(`Database path is publicly servable: ${path}. Move CAMPING_DB outside the build output and any public directory.`);
    this.name = 'PublicDbPathError';
    this.path = path;
  }
}

// Windows file systems are case-insensitive by default, so compare there without case.
const foldCase = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
const isInside = (candidate, root) => {
  const rel = relative(foldCase(root), foldCase(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Pure decision (Req 20.9): true when either the resolved path or its symlink-resolved form has a
// `dist` or `public` segment (any case) or lies inside one of the public roots (already resolved).
export function isPublicDbPath(full, real, publicRoots = []) {
  for (const candidate of [full, real]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (candidate.split(/[\\/]+/).some(part => PUBLIC_DIRS.has(part.toLowerCase()))) return true;
    if (publicRoots.some(root => typeof root === 'string' && root && isInside(candidate, root))) return true;
  }
  return false;
}

// realpath of the nearest existing ancestor, joined with the segments that do not exist yet.
function realpathOfNearest(full) {
  const rest = [];
  let current = full;
  for (;;) {
    try { return join(realpathSync.native(current), ...rest.reverse()); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return full;
      rest.push(basename(current));
      current = parent;
    }
  }
}


export function assertPrivateDbPath(dbPath, { publicRoots = [] } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('dbPath is required');
  if (dbPath === ':memory:') return dbPath;
  const full = resolve(dbPath);
  const real = realpathOfNearest(full);
  const roots = (publicRoots || []).filter(root => typeof root === 'string' && root).flatMap(root => [resolve(root), realpathOfNearest(resolve(root))]);
  if (isPublicDbPath(full, real, roots)) throw new PublicDbPathError(full);
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  return full;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
// Fails closed: a malformed or impossible stored hash returns false instead of throwing (Req 2.6).
async function verifyPassword(password, stored) {
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
  }
  if (!trip.title) fail(400, '請填寫旅行名稱。');
  for (const key of ['startDate', 'endDate']) if (typeof trip[key] !== 'string') fail(400, '請填寫旅行日期。');
  if (!dateRange(trip.startDate, trip.endDate).length) fail(400, '日期需為有效日期，結束不早於開始，且最長 31 天。');
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
const isLoopbackIp = ip => /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(ip);
function isLoopback(url, info, allowLoopbackHostFromContainer = false) {
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (allowLoopbackHostFromContainer) return true;
  if (info?.ip !== undefined) return typeof info.ip === 'string' && isLoopbackIp(info.ip);
  return true;
}
function clientKey(info) {
  const address = info?.clientAddress ?? info?.ip;
  return typeof address === 'string' && address ? address.slice(0, 64) : 'local';
}
const DEFAULT_DEPLOYMENT = Object.freeze({ published: false, registrationPolicy: 'open', receiptAiPolicySeed: null });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, destination TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  description TEXT NOT NULL, note TEXT NOT NULL,
  cover_kind TEXT NOT NULL CHECK (cover_kind IN ('camp','mountain','lake','night','forest','beach','sunrise')),
  status TEXT NOT NULL CHECK (status IN ('planning','completed')),
  revision INTEGER NOT NULL, people_count INTEGER NOT NULL, state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id), user_id TEXT NOT NULL REFERENCES users(id),
  person_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id), UNIQUE (trip_id, person_id)
);
CREATE INDEX IF NOT EXISTS trip_members_user ON trip_members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  used_at INTEGER, used_by TEXT REFERENCES users(id),
  -- Nullable on purpose: ALTER TABLE cannot add a NOT NULL column without a default, so migrated tables
  -- get a nullable id. Declaring it the same way here keeps new and migrated tables identical; the
  -- invites_id unique index (migrateInviteColumns) and insertInvite always supplying an id cover the rest.
  id TEXT
);
CREATE INDEX IF NOT EXISTS invites_trip ON invites(trip_id);
CREATE TABLE IF NOT EXISTS trip_deletions (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), deleted_by TEXT NOT NULL REFERENCES users(id), deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
-- One row per OpenAI call (Req 18.3, 18.5). trip_id has no foreign key so usage survives trip deletion.
CREATE TABLE IF NOT EXISTS receipt_ai_usage (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), trip_id TEXT NOT NULL,
  model_id TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','success','error','timeout'))
);
CREATE INDEX IF NOT EXISTS receipt_ai_usage_at ON receipt_ai_usage(at);
CREATE INDEX IF NOT EXISTS receipt_ai_usage_user_at ON receipt_ai_usage(user_id, at);`;

function migrateCoverKinds(db) {
  const schema = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='trips'").get()?.sql || '';
  if (COVER_KINDS.every(kind => schema.includes(`'${kind}'`))) return;
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE trips_new (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL, destination TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        description TEXT NOT NULL, note TEXT NOT NULL,
        cover_kind TEXT NOT NULL CHECK (cover_kind IN ('camp','mountain','lake','night','forest','beach','sunrise')),
        status TEXT NOT NULL CHECK (status IN ('planning','completed')),
        revision INTEGER NOT NULL, people_count INTEGER NOT NULL, state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO trips_new SELECT * FROM trips;
      DROP TABLE trips;
      ALTER TABLE trips_new RENAME TO trips;
      COMMIT;`);
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Adds invite usage and id columns to databases created before single-use invites (Req 17.7, 19.9).
// The unique index lives here, not in SCHEMA, because SCHEMA runs before an old table has the id column.
function migrateInviteColumns(db) {
  const columns = new Set(db.query('PRAGMA table_info(invites)').all().map(c => c.name));
  const indexes = new Set(db.query('PRAGMA index_list(invites)').all().map(i => i.name));
  const missingIds = columns.has('id') && db.query('SELECT 1 FROM invites WHERE id IS NULL LIMIT 1').get();
  if (['used_at', 'used_by', 'id'].every(c => columns.has(c)) && indexes.has('invites_id') && !missingIds) return;
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (!columns.has('used_at')) db.exec('ALTER TABLE invites ADD COLUMN used_at INTEGER');
    if (!columns.has('used_by')) db.exec('ALTER TABLE invites ADD COLUMN used_by TEXT REFERENCES users(id)');
    if (!columns.has('id')) db.exec('ALTER TABLE invites ADD COLUMN id TEXT');
    const setId = db.query('UPDATE invites SET id = ? WHERE token_hash = ?');
    for (const { token_hash } of db.query('SELECT token_hash FROM invites WHERE id IS NULL').all()) setId.run(randomUUID(), token_hash);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invites_id ON invites(id)');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function createAccountService({ dbPath, now, receiptAi = null, allowLoopbackHostFromContainer = false, deployment = DEFAULT_DEPLOYMENT, publicRoots = [], aiCost = AI_COST_DEFAULTS, securityEventLimits = {}, alertLog = console.error } = {}) {
  // The path guard runs first, so a public DB path creates and opens nothing (Req 20.9).
  const privateDbPath = assertPrivateDbPath(dbPath, { publicRoots });
  const published = deployment?.published === true;
  // Published_Mode always locks open registration (Req 10.4); otherwise only an explicit 'closed' locks it.
  const registrationOpen = !published && (deployment?.registrationPolicy ?? 'open') !== 'closed';
  const clock = () => { const value = now ? now() : Date.now(); return value instanceof Date ? value.getTime() : Number(value); };
  const iso = () => new Date(clock()).toISOString();
  const db = new Database(privateDbPath, { create: true });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  // SECURITY_EVENTS_SCHEMA: Failed_Login_Events and Security_Alerts (Req 23), separate from audit.
  db.exec(SCHEMA + LEDGER_SCHEMA + SECURITY_EVENTS_SCHEMA);
  migrateCoverKinds(db);
  migrateInviteColumns(db);
  const limiter = new RateLimiter(clock);
  // Every Security_Alert goes through this one dispatcher (Req 23.16). securityEventLimits lets tests lower the caps.
  const securityEvents = createSecurityEventStore(db, clock, {
    ...(Number.isSafeInteger(securityEventLimits?.maxEvents) ? { maxEvents: securityEventLimits.maxEvents } : {}),
    ...(Number.isSafeInteger(securityEventLimits?.maxAlerts) ? { maxAlerts: securityEventLimits.maxAlerts } : {})
  });
  const alertDispatcher = createAlertDispatcher({ store: securityEvents, log: alertLog });
  securityEvents.attachDispatcher(alertDispatcher);
  const aiActive = new Map();
  let closed = false, dummyHash;
  const TRIP_SELECT = 'SELECT t.*, u.username AS owner_username, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.owner_id';
  const LIVE = 'NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = t.id)';

  const q = {
    userCount: db.query('SELECT COUNT(*) AS n FROM users'),
    userById: db.query('SELECT * FROM users WHERE id = ?'),
    userByName: db.query('SELECT * FROM users WHERE username = ?'),
    insertUser: db.query('INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    updatePassword: db.query('UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL'),
    activeAdmins: db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL"),
    listUsers: db.query('SELECT u.*, (SELECT COUNT(*) FROM trip_members m WHERE m.user_id = u.id AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = m.trip_id)) AS trip_count FROM users u ORDER BY u.created_at, u.username'),
    updateUser: db.query('UPDATE users SET display_name = ?, role = ? WHERE id = ? AND deleted_at IS NULL'),
    softDelete: db.query('UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    sessionUser: db.query('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL'),
    insertSession: db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    deleteSession: db.query('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpiredSessions: db.query('DELETE FROM sessions WHERE expires_at <= ?'),
    trimSessions: db.query('DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)'),
    deleteUserSessions: db.query('DELETE FROM sessions WHERE user_id = ?'),
    tripById: db.query(`${TRIP_SELECT} WHERE t.id = ? AND ${LIVE}`),
    anyTripById: db.query(`${TRIP_SELECT} WHERE t.id = ?`),
    tripDeletion: db.query('SELECT 1 AS deleted FROM trip_deletions WHERE trip_id = ?'),
    insertTripDeletion: db.query('INSERT INTO trip_deletions (trip_id, deleted_by, deleted_at) VALUES (?, ?, ?)'),
    allTrips: db.query(`${TRIP_SELECT} WHERE ${LIVE} ORDER BY t.start_date DESC, t.created_at DESC`),
    myTrips: db.query(`${TRIP_SELECT} WHERE (t.owner_id = ? OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = t.id AND m.user_id = ?)) AND ${LIVE} ORDER BY t.start_date DESC, t.created_at DESC`),
    ownedTrips: db.query('SELECT id FROM trips WHERE owner_id = ?'),
    insertTrip: db.query('INSERT INTO trips (id, owner_id, title, destination, start_date, end_date, description, note, cover_kind, status, revision, people_count, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateTrip: db.query('UPDATE trips SET owner_id = ?, title = ?, destination = ?, start_date = ?, end_date = ?, description = ?, note = ?, cover_kind = ?, status = ?, revision = ?, people_count = ?, state_json = ?, updated_at = ? WHERE id = ? AND revision = ?'),
    membership: db.query('SELECT person_id FROM trip_members WHERE trip_id = ? AND user_id = ?'),
    membersOf: db.query('SELECT user_id, person_id FROM trip_members WHERE trip_id = ?'),
    tripsOfMember: db.query('SELECT trip_id, person_id FROM trip_members WHERE user_id = ?'),
    insertMember: db.query('INSERT INTO trip_members (trip_id, user_id, person_id, joined_at) VALUES (?, ?, ?, ?)'),
    deleteMember: db.query('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?'),
    activeInvites: db.query('SELECT COUNT(*) AS n FROM invites WHERE trip_id = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?'),
    activeInvitesByUser: db.query('SELECT COUNT(*) AS n FROM invites WHERE trip_id = ? AND created_by = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?'),
    insertInvite: db.query('INSERT INTO invites (id, token_hash, trip_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    // Usable token row, ignoring used_at (callers decide). The creator must still be the owner, an admin, or a trip member.
    inviteForUse: db.query(`SELECT i.*, u.display_name AS inviter_name FROM invites i
      JOIN users u ON u.id = i.created_by JOIN trips t ON t.id = i.trip_id
      WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > ? AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = i.trip_id)
        AND (t.owner_id = i.created_by OR u.role = 'admin'
             OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = i.trip_id AND m.user_id = i.created_by))`),
    consumeInvite: db.query('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL'),
    // Invite_List (Req 19.1, 19.2, 19.3, 19.5): selects no token_hash, account id, or username.
    listTripInvites: db.query(`SELECT i.id, u.display_name AS creator_name, i.created_at, i.expires_at FROM invites i
      JOIN users u ON u.id = i.created_by
      WHERE i.trip_id = ? AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at > ?
      ORDER BY i.created_at DESC, i.id`),
    listTripInvitesBy: db.query(`SELECT i.id, u.display_name AS creator_name, i.created_at, i.expires_at FROM invites i
      JOIN users u ON u.id = i.created_by
      WHERE i.trip_id = ? AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at > ? AND i.created_by = ?
      ORDER BY i.created_at DESC, i.id`),
    activeInviteById: db.query('SELECT id, created_by FROM invites WHERE id = ? AND trip_id = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?'),
    revokeInviteById: db.query('UPDATE invites SET revoked_at = ? WHERE id = ? AND trip_id = ? AND revoked_at IS NULL AND used_at IS NULL'),
    revokeTripInvites: db.query('UPDATE invites SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL'),
    revokeInvitesBy: db.query('UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL'),
    revokeTripInvitesBy: db.query('UPDATE invites SET revoked_at = ? WHERE trip_id = ? AND created_by = ? AND revoked_at IS NULL AND used_at IS NULL'),
    revokeInvitesWithoutRights: db.query(`UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL AND used_at IS NULL
      AND trip_id NOT IN (SELECT id FROM trips WHERE owner_id = ?)
      AND trip_id NOT IN (SELECT trip_id FROM trip_members WHERE user_id = ?)`),
    insertAudit: db.query('INSERT INTO audit (at, actor, action, target) VALUES (?, ?, ?, ?)'),
    trimAudit: db.query('DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)'),
    listAudit: db.query('SELECT at, actor, action, target FROM audit ORDER BY id DESC LIMIT 200'),
    settingByKey: db.query('SELECT value, updated_at, updated_by FROM settings WHERE key = ?'),
    upsertSetting: db.query('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'),
    ledgerByTrip: db.query('SELECT * FROM trip_ledgers WHERE trip_id = ?'),
    insertLedger: db.query('INSERT INTO trip_ledgers (trip_id, revision, ledger_json, requests_json, updated_by, updated_at) VALUES (?, 1, ?, ?, ?, ?)'),
    updateLedger: db.query('UPDATE trip_ledgers SET revision = revision + 1, ledger_json = ?, requests_json = ?, updated_by = ?, updated_at = ? WHERE trip_id = ? AND revision = ?'),
    updateLedgerPeople: db.query('UPDATE trip_ledgers SET ledger_json = ? WHERE trip_id = ? AND revision = ?'),
    usageUserTimes: db.query('SELECT at FROM receipt_ai_usage WHERE user_id = ? AND at > ? ORDER BY at'),
    usageCountSince: db.query('SELECT COUNT(*) AS n FROM receipt_ai_usage WHERE at >= ?'),
    usageTotalsSince: db.query('SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion FROM receipt_ai_usage WHERE at >= ?'),
    insertUsage: db.query("INSERT INTO receipt_ai_usage (id, at, user_id, trip_id, model_id, outcome) VALUES (?, ?, ?, ?, ?, 'pending')"),
    settleUsage: db.query('UPDATE receipt_ai_usage SET outcome = ?, prompt_tokens = ?, completion_tokens = ? WHERE id = ?'),
    trimUsage: db.query('DELETE FROM receipt_ai_usage WHERE at < ?')
  };

  const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role });
  const audit = (actor, action, target) => { q.insertAudit.run(clock(), actor, action, target); q.trimAudit.run(MAX_AUDIT); };
  const needsSetup = () => q.userCount.get().n === 0;
  const tx = fn => db.transaction(fn).immediate();
  // Read on every call so an admin change applies to the next request without a restart (Req 11.8).
  // The seed is a read-time fallback only and is never written (Req 11.5-11.7, 11.12).
  function receiptAiPolicy() {
    const row = q.settingByKey.get(RECEIPT_AI_KEY);
    const { value, source } = resolveReceiptAiPolicy(row?.value ?? null, deployment?.receiptAiPolicySeed ?? null);
    return { value, source, updatedAt: row ? new Date(row.updated_at).toISOString() : null, updatedBy: row?.updated_by ?? null };
  }
  const settingsBody = () => ({ receiptAiPolicy: { ...receiptAiPolicy(), options: RECEIPT_AI_POLICIES } });
  // Shared by POST /api/setup and the create-admin CLI (Req 8.5, 8.13). BEGIN IMMEDIATE makes the
  // count check and insert atomic across processes, so a concurrent creation gets 409 (Req 8.14).
  // The password is only hashed; it is never logged or written to the audit log.
  async function createFirstAdmin(input, { auditAction = 'setup' } = {}) {
    const { username: rawUsername, displayName: rawDisplayName, password } = input ?? {};
    const username = validateUsername(rawUsername), displayName = validateDisplayName(rawDisplayName);
    const hash = await hashPassword(validatePassword(password));
    return tx(() => {
      if (q.userCount.get().n !== 0) fail(409, '管理員已設定完成。');
      const id = randomUUID();
      q.insertUser.run(id, username, displayName, 'admin', hash, clock());
      audit(username, auditAction, `user:${username}`);
      return q.userById.get(id);
    });
  }

  async function resetPassword(username, password) {
    const validUsername = validateUsername(username);
    const hash = await hashPassword(validatePassword(password));
    return tx(() => {
      const user = q.userByName.get(validUsername);
      if (!user || user.deleted_at !== null) fail(404, '找不到這個帳號。');
      q.updatePassword.run(hash, user.id);
      q.deleteUserSessions.run(user.id);
      audit('local-cli', 'password.reset.cli', `user:${validUsername}`);
      return validUsername;
    });
  }

  const cookieHeader = (secure, token, maxAge) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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
  function currentUser(request) {
    const token = sessionToken(request);
    return token ? q.sessionUser.get(sha256(token), clock()) || null : null;
  }
  const requireUser = request => currentUser(request) || fail(401, '請先登入。');
  const requireAdmin = request => { const user = requireUser(request); if (user.role !== 'admin') fail(403, '需要管理員權限。'); return user; };
  const requireExpectedUser = (request, expectedUserId) => {
    const user = requireUser(request);
    if (expectedUserId !== undefined && (typeof expectedUserId !== 'string' || expectedUserId !== user.id)) fail(409, '登入帳號已在其他分頁變更，這份資料未儲存。');
    return user;
  };

  function startSession(request, info, user, extra = {}) {
    const previous = sessionToken(request);
    if (previous) q.deleteSession.run(sha256(previous));
    const token = newToken(), at = clock();
    q.deleteExpiredSessions.run(at);
    q.insertSession.run(sha256(token), user.id, at, at + SESSION_TTL);
    q.trimSessions.run(user.id, user.id, MAX_SESSIONS_PER_USER);
    return json(200, { user: publicUser(user), needsSetup: false, ...extra }, [['Set-Cookie', cookieHeader(info.secureCookie === true, token, SESSION_TTL / 1000)]]);
  }

  // Rate-limit refusal with Retry-After set to the longest remaining window of the blocked keys (Req 4.5).
  const limited = (keys, message) => fail(429, message, [['Retry-After', String(Math.max(...keys.map(k => limiter.retryAfter(k))))]]);

  // Persistent receipt AI quota (Req 18.3, 18.4, 18.9). The count check and the `pending` row insert run in
  // one BEGIN IMMEDIATE transaction, so they are atomic across processes. A crash leaves a `pending` row that
  // still counts, which errs toward lower spending.
  const AI_UNAVAILABLE = 'AI 辨識服務暫時無法使用，請稍後再試。';
  const USAGE_RETENTION = 400 * DAY;
  function reserveAiCall(userId, tripId) {
    try {
      return tx(() => {
        const at = clock();
        const userTimes = q.usageUserTimes.all(userId, at - PER_USER_WINDOW_MS).map(r => r.at);
        const dayCount = q.usageCountSince.get(utcDayStart(at)).n;
        const monthCount = q.usageCountSince.get(utcMonthStart(at)).n;
        const decision = quotaDecision({ now: at, userTimes, dayCount, monthCount, config: aiCost });
        if (!decision.ok) fail(429, 'AI 辨識次數已達上限，請稍後再試。', [['Retry-After', String(decision.retryAfter)]]);
        const id = randomUUID();
        q.insertUsage.run(id, at, userId, tripId, aiCost.modelId);
        q.trimUsage.run(at - USAGE_RETENTION);
        return id;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(503, AI_UNAVAILABLE);
    }
  }
  // Settles the reserved row. A failed update is logged and does not change the response, because the call happened.
  function settleAiCall(id, outcome, usage, request, url) {
    if (closed) return;
    const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    try { q.settleUsage.run(outcome, tokens(usage?.promptTokens), tokens(usage?.completionTokens), id); }
    catch (error) { logRequestError({ method: request.method, url, error }); }
  }
  const isAiTimeout = error => (error instanceof ReceiptAiError && error.status === 504) || error?.name === 'AbortError' || error?.name === 'TimeoutError';
  function usagePeriod(start) {
    const row = q.usageTotalsSince.get(start);
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
  function tripAccess(user, tripId) {
    const row = ID.test(tripId) ? q.tripById.get(tripId) : null;
    if (!row) fail(404, '找不到這趟旅行。');
    const personId = q.membership.get(tripId, user.id)?.person_id ?? null;
    const caps = capabilities(row, user, !!personId);
    if (!caps.canEdit) fail(404, '找不到這趟旅行。');
    return { row, personId, ...caps };
  }
  // tripAccess already 404s for accounts outside the trip; this keeps the Inviter rule explicit (Req 16.3).
  const requireInviter = access => { if (!access.canInvite) fail(404, '找不到這趟旅行。'); return access; };
  // Every path that deletes a trip_members row must call this in the same transaction (Req 16.7).
  const revokeCreatorTripInvites = (tripId, userId) => q.revokeTripInvitesBy.run(clock(), tripId, userId);
  function requireRevision(access, revision) {
    if (!Number.isSafeInteger(revision)) fail(400, '缺少版本號 revision。');
    if (revision !== access.row.revision) fail(409, '旅行已被其他人更新，請重新載入後再修改。');
  }
  const ownerPersonId = row => q.membership.get(row.id, row.owner_id)?.person_id ?? null;

  const summary = (row, user) => {
    const isMember = row.owner_id === user.id || !!q.membership.get(row.id, user.id);
    const caps = capabilities(row, user, isMember);
    return {
      id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, ownerUsername: row.owner_username,
      title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date,
      description: row.description, note: row.note, coverKind: row.cover_kind, status: row.status,
      revision: row.revision, canEdit: caps.canEdit, canDelete: caps.canDelete, canInvite: caps.canInvite, canManage: caps.canManage,
      memberCount: row.people_count, isMember
    };
  };
  function envelope(user, tripId) {
    const access = tripAccess(user, tripId);
    const state = JSON.parse(access.row.state_json);
    const has = id => !!id && state.people.some(p => p.id === id);
    const viewer = has(access.personId) ? access.personId : ownerPersonId(access.row);
    state.currentUser = has(viewer) ? viewer : state.people[0].id;
    state.revision = access.row.revision;
    state.joined = true;
    const { canEdit, canDelete, canInvite, canManage, personId } = access;
    return { trip: summary(access.row, user), state, permissions: { canEdit, canDelete, canInvite, canManage, personId } };
  }

  function actorName(user, state, personId) {
    const person = personId && state.people.find(p => p.id === personId);
    return person ? person.name : `${user.display_name}（管理員）`;
  }
  function pushEvent(state, text, actor) {
    state.events = [{ id: randomUUID(), text: String(text).slice(0, 200), actor, at: iso() }, ...state.events].slice(0, 50);
  }

  function persist(row, state, meta = {}) {
    const ownerId = meta.ownerId ?? row.owner_id;
    const revision = row.revision + 1;
    const anchor = q.membership.get(row.id, ownerId)?.person_id;
    state.revision = revision;
    state.joined = true;
    state.currentUser = state.people.some(p => p.id === anchor) ? anchor : state.people[0]?.id;
    if (!isValidState(state)) fail(400, '旅行資料格式不正確，未儲存。');
    const t = state.trip;
    const result = q.updateTrip.run(ownerId, t.title, t.destination, t.startDate, t.endDate, t.description, t.note,
      meta.coverKind ?? row.cover_kind, meta.status ?? row.status, revision, state.people.length, JSON.stringify(state), clock(), row.id, row.revision);
    if (result.changes !== 1) fail(409, '旅行已被其他人更新，請重新載入後再修改。');
    snapshotRemovedPeople(row, state);
  }
  // A person leaving the trip keeps the name they had while they still owe or are owed money; the debt itself is never moved.
  function snapshotRemovedPeople(row, state) {
    const before = JSON.parse(row.state_json).people;
    const kept = new Set(state.people.map(p => p.id));
    const removed = new Set(before.filter(p => !kept.has(p.id)).map(p => p.id));
    const ledgerRow = removed.size ? q.ledgerByTrip.get(row.id) : null;
    if (!ledgerRow) return;
    let stored;
    try { stored = readLedgerRow(ledgerRow).ledger; } catch { return; }
    const next = refreshSnapshotNames(stored, before, removed);
    q.updateLedgerPeople.run(JSON.stringify(next), row.id, ledgerRow.revision);
  }
  function ledgerAccess(user, tripId) {
    const access = tripAccess(user, tripId);
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
  const DENY_REMOVAL = '受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。';
  const DENY_PACKING = '只能變更自己的行前準備。';
  // A row someone bought stays a manual row once a member unticks it, so a later recipe edit cannot prune it.
  const retainPurchased = (old, item) => { if (old?.done && !item.done && item.source === 'meal') item.source = 'manual'; };
  // Invited members may add and edit, but never remove items, rewrite other accounts' identities or pack for others.
  function guardCollaborator(tripId, stored, next, me) {
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
    const bound = new Set(q.membersOf.all(tripId).map(b => b.person_id));
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
  function resolveInvite(token) {
    const invite = TOKEN.test(token) ? q.inviteForUse.get(sha256(token), clock()) : null;
    const row = invite ? q.tripById.get(invite.trip_id) : null;
    if (!row) fail(404, '邀請連結無效或已過期。');
    return { invite, row };
  }
  const inTrip = (row, userId) => row.owner_id === userId || !!q.membership.get(row.id, userId);
  // Valid_Invite: resolvable and not yet used.
  function usableInvite(token) {
    const found = resolveInvite(token);
    if (found.invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
    return found;
  }
  // Must run inside tx with the membership insert; the used_at guard makes a second consumption fail.
  function consumeInTx(invite, userId) {
    if (q.consumeInvite.run(clock(), userId, invite.token_hash).changes !== 1) fail(404, '邀請連結無效或已過期。');
  }
  function addMemberInTx(row, userId, name, role) {
    let added;
    try { added = addParticipant(JSON.parse(row.state_json), name, role); } catch (error) {
      fail(/已在小隊|額滿/.test(error.message) ? 409 : 400, error.message);
    }
    q.insertMember.run(row.id, userId, added.person.id, clock());
    pushEvent(added.state, `${added.person.name} 加入了小隊`, added.person.name);
    persist(row, added.state);
  }

  async function softDeleteTrip(request, tripId, adminOnly) {
    requireJsonType(request);
    if (adminOnly) requireAdmin(request); else requireUser(request);
    const body = await readJson(request);
    if (typeof body.expectedUserId !== 'string') fail(400, '缺少目前登入帳號 expectedUserId。');
    tx(() => {
      const user = requireExpectedUser(request, body.expectedUserId);
      if (adminOnly && user.role !== 'admin') fail(403, '需要管理員權限。');
      const row = ID.test(tripId) ? q.anyTripById.get(tripId) : null;
      if (!row) fail(404, '找不到這趟旅行。');
      const deleted = !!q.tripDeletion.get(tripId);
      if (!capabilities(row, user, false).canDelete) {
        if (!deleted && q.membership.get(tripId, user.id)) fail(403, '受邀旅伴可以編輯旅行，但只有主辦人或管理員可以刪除。');
        fail(404, '找不到這趟旅行。');
      }
      if (deleted) fail(409, '這趟旅行已刪除。');
      if (typeof body.confirmTitle !== 'string' || body.confirmTitle !== row.title) fail(400, '請輸入要刪除的旅行名稱以確認。');
      requireRevision({ row }, body.revision);
      const at = clock();
      q.insertTripDeletion.run(tripId, user.id, at);
      q.revokeTripInvites.run(at, tripId);
      audit(user.username, 'trip.delete', `trip:${tripId}`);
    });
    return json(200, { ok: true });
  }

  const routes = {
    getSession(request) {
      const user = currentUser(request);
      const setupNeeded = needsSetup();
      return json(200, {
        user: user ? publicUser(user) : null, needsSetup: setupNeeded,
        webSetup: !published, registrationOpen, inviteRegistration: !setupNeeded
      });
    },

    async setup(request, url, info) {
      if (!isLoopback(url, info, allowLoopbackHostFromContainer)) fail(403, '首次管理員設定只能在本機進行。');
      requireJsonType(request);
      if (!needsSetup()) fail(409, '管理員已設定完成。');
      const user = await createFirstAdmin(await readJson(request));
      return startSession(request, info, user);
    },

    async register(request, url, info) {
      // Checked before the limiter and before the body, so a closed site neither reads input nor spends the bucket.
      if (!registrationOpen) fail(403, '目前不開放公開註冊，請使用旅行邀請連結建立帳號。');
      const key = `register:${clientKey(info)}`;
      if (limiter.blocked(key, LIMITS.register)) limited([key], '註冊嘗試太多次，請稍後再試。');
      limiter.hit(key, LIMITS.register);
      // needsSetup stays ahead of the 415: the shipped PBN register-bucket property expects 409 for a
      // body-less request before the first admin exists. No session can exist in that state.
      if (needsSetup()) fail(409, '請先完成管理員設定。');
      requireJsonType(request);
      const body = await readJson(request);
      const username = validateUsername(body.username), displayName = validateDisplayName(body.displayName);
      validatePassword(body.password);
      if (q.userByName.get(username)) fail(409, '這個帳號名稱已被使用。');
      const hash = await hashPassword(body.password);
      const user = tx(() => {
        if (q.userByName.get(username)) fail(409, '這個帳號名稱已被使用。');
        const id = randomUUID();
        q.insertUser.run(id, username, displayName, 'member', hash, clock());
        audit(username, 'register', `user:${username}`);
        return q.userById.get(id);
      });
      return startSession(request, info, user);
    },

    // Every exit that starts no Session records exactly one Failed_Login_Event (Req 23.1), except that
    // rate_limited is recorded once per blocked key per window (Req 23.5). The password never reaches record().
    async login(request, url, info) {
      const client = clientKey(info);
      const record = (reason, rawUsername) => {
        try {
          securityEvents.recordFailedLogin({ at: clock(), client, username: eventUsername(rawUsername), reason });
        } catch (error) {
          // A failed write keeps the login response unchanged (Req 23.15); only the error name is logged.
          logRequestError({ method: request.method, url, error });
        }
      };
      let body;
      try { body = await readJson(request); } catch (error) {
        if (error instanceof HttpError) record('invalid_input', null);
        throw error;
      }
      if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
        record('invalid_input', body?.username);
        fail(400, '請輸入帳號與密碼。');
      }
      const username = body.username.trim().toLowerCase().slice(0, 64);
      const userKey = `login:user:${username}`, clientLimitKey = `login:client:${client}`;
      const blockedKeys = [[userKey, LIMITS.loginUser], [clientLimitKey, LIMITS.loginClient]].filter(([k, l]) => limiter.blocked(k, l)).map(([k]) => k);
      if (blockedKeys.length) {
        // map, not some: every blocked key is marked noted in this window, so each key records at most once.
        if (blockedKeys.map(k => limiter.noteOnce(k)).includes(true)) record('rate_limited', body.username);
        limited(blockedKeys, '登入失敗次數太多，請 15 分鐘後再試。');
      }
      const user = q.userByName.get(username);
      const password = body.password.length <= 1024 ? body.password : '';
      dummyHash ||= await hashPassword(newToken());
      const ok = await verifyPassword(password, user?.password_hash || dummyHash);
      if (!ok || !user || user.deleted_at !== null || !password) {
        limiter.hit(userKey, LIMITS.loginUser);
        limiter.hit(clientLimitKey, LIMITS.loginClient);
        record(user && user.deleted_at !== null && ok && password ? 'deleted_account' : 'bad_credentials', body.username);
        fail(401, '帳號或密碼不正確。');
      }
      limiter.clear(userKey);
      audit(user.username, 'login', `user:${user.username}`);
      return startSession(request, info, user);
    },

    logout(request, url, info) {
      const token = sessionToken(request);
      if (token) q.deleteSession.run(sha256(token));
      return json(200, { ok: true }, [['Set-Cookie', cookieHeader(info.secureCookie === true, '', 0)]]);
    },

    listTrips(request) {
      const user = requireUser(request);
      const rows = user.role === 'admin' ? q.allTrips.all() : q.myTrips.all(user.id, user.id);
      return json(200, { trips: rows.map(row => summary(row, user)) });
    },

    async createTrip(request) {
      requireJsonType(request);
      const user = requireUser(request);
      const body = await readJson(request);
      const legacy = body.legacyState !== undefined;
      let state = legacy ? cleanState(body.legacyState) : null;
      if (legacy && (!state || !isValidState(state))) fail(400, '匯入的旅行資料格式不正確。');
      const base = legacy ? { ...state.trip, coverKind: 'camp', status: 'planning' } : { destination: '', description: '', note: '', coverKind: 'camp', status: 'planning' };
      const card = mergeCard(body, base, legacy ? [] : ['title', 'startDate', 'endDate']);
      state ||= { schema: 1, revision: 0, currentUser: '', joined: true, trip: { ...card }, people: [], activities: [], meals: [], shopping: [], gear: [], vehicles: [], events: [], departed: [] };
      applyCardToState(state, card);
      const added = addUniqueParticipant(state, user.display_name, '這趟的召集人');
      state = added.state;
      state.currentUser = added.person.id;
      state.revision = 1;
      runSync(state);
      pushEvent(state, legacy ? '匯入了旅行手冊' : '建立了這本旅行手冊', added.person.name);
      if (!isValidState(state)) fail(400, '旅行資料格式不正確。');
      const id = randomUUID(), at = clock();
      tx(() => {
        if (requireExpectedUser(request, body.expectedUserId).id !== user.id) fail(401, '請先登入。');
        q.insertTrip.run(id, user.id, card.title, card.destination, card.startDate, card.endDate, card.description, card.note, card.coverKind, card.status, 1, state.people.length, JSON.stringify(state), at, at);
        q.insertMember.run(id, user.id, added.person.id, at);
        audit(user.username, 'trip.create', `trip:${id}`);
      });
      return json(201, { trip: summary(q.tripById.get(id), user) });
    },

    getTrip(request, url, info, [tripId]) {
      return json(200, envelope(requireUser(request), tripId));
    },

    async putTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      tx(() => {
        user = requireExpectedUser(request, body.expectedUserId);
        const access = tripAccess(user, tripId);
        requireRevision(access, body.revision);
        const stored = JSON.parse(access.row.state_json);
        const next = cleanState(body.state);
        if (!next || !Array.isArray(next.people) || !next.people.length) fail(400, '旅行資料格式不正確。');
        next.revision = access.row.revision;
        next.joined = true;
        next.currentUser = next.people[0]?.id;
        if (!isValidState(next)) fail(400, '旅行資料格式不正確。');
        for (const binding of q.membersOf.all(tripId)) {
          const person = next.people.find(p => p.id === binding.person_id);
          if (!person) fail(409, '已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。');
          const checked = validateName(person.name, person.role);
          person.name = checked.name;
          person.role = normalizeParticipantName(person.role);
          if (next.people.some(p => p.id !== person.id && participantKey(p.name) === participantKey(person.name))) fail(409, '這個名字已在小隊中，請使用不同暱稱。');
        }
        validateTripText(next.trip);
        if (!access.canDelete) guardCollaborator(tripId, stored, next, access.personId);
        const actor = actorName(user, next, access.personId);
        const known = new Set(stored.events.map(ev => ev.id));
        const fresh = next.events.filter(ev => !known.has(ev.id)).slice(0, MAX_CLIENT_EVENTS)
          .map(ev => ({ id: randomUUID(), text: ev.text.slice(0, 200), actor, at: iso() }));
        next.events = [...fresh, ...stored.events].slice(0, 50);
        if (!fresh.length) pushEvent(next, '更新了旅行手冊', actor);
        runSync(next);
        if (!access.canDelete) guardShoppingRemoval(stored, next);
        persist(access.row, next);
        audit(user.username, 'trip.update', `trip:${tripId}`);
      });
      return json(200, envelope(user, tripId));
    },

    async patchTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      tx(() => {
        user = requireExpectedUser(request, body.expectedUserId);
        const access = tripAccess(user, tripId);
        requireRevision(access, body.revision);
        const state = JSON.parse(access.row.state_json);
        const card = mergeCard(body, { ...state.trip, coverKind: access.row.cover_kind, status: access.row.status }, []);
        applyCardToState(state, card);
        pushEvent(state, '更新了旅行設定', actorName(user, state, access.personId));
        persist(access.row, state, { coverKind: card.coverKind, status: card.status });
        audit(user.username, 'trip.meta', `trip:${tripId}`);
      });
      return json(200, envelope(user, tripId));
    },

    async checkTrip(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      if (!['shopping', 'gear', 'depart'].includes(body.kind) || typeof body.checked !== 'boolean') fail(400, '勾選資料不正確。');
      tx(() => {
        user = requireExpectedUser(request, body.expectedUserId);
        const access = tripAccess(user, tripId);
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
        persist(access.row, state);
        audit(user.username, `trip.check.${body.kind}`, `trip:${tripId}`);
      });
      return json(200, envelope(user, tripId));
    },

    async createInvite(request, url, info, [tripId]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      const token = newToken(), id = randomUUID(), at = clock(), expiresAt = at + INVITE_TTL;
      tx(() => {
        user = requireExpectedUser(request, body.expectedUserId);
        const access = requireInviter(tripAccess(user, tripId));
        if (q.activeInvites.get(tripId, at).n >= MAX_ACTIVE_INVITES) fail(409, `每趟旅行最多 ${MAX_ACTIVE_INVITES} 個有效邀請連結。`);
        if (!access.canManage && q.activeInvitesByUser.get(tripId, user.id, at).n >= MAX_MEMBER_INVITES) {
          fail(409, `每位旅伴在每趟旅行最多 ${MAX_MEMBER_INVITES} 個有效邀請連結。`);
        }
        q.insertInvite.run(id, sha256(token), tripId, user.id, at, expiresAt);
        audit(user.username, 'invite.create', `trip:${tripId}`);
      });
      return json(201, { id, token, urlPath: `/invite/${token}`, expiresAt: new Date(expiresAt).toISOString() });
    },

    // Invite_List (Req 19.1–19.7): managers see every Active_Invite, members only their own.
    listInvites(request, url, info, [tripId]) {
      const user = requireUser(request);
      const access = requireInviter(tripAccess(user, tripId));
      const at = clock();
      const rows = access.canManage ? q.listTripInvites.all(tripId, at) : q.listTripInvitesBy.all(tripId, at, user.id);
      return json(200, { invites: rows.map(r => ({
        id: r.id, creatorName: r.creator_name,
        createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString()
      })) });
    },

    getInvite(request, url, info, [token]) {
      const user = requireUser(request);
      const { invite, row } = resolveInvite(token);
      const alreadyMember = inTrip(row, user.id);
      if (!alreadyMember && invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
      return json(200, { title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date, alreadyMember });
    },

    // Signed-out preview (Req 15): rate-limited before the lookup, no session read, no writes.
    invitePreview(request, url, info, [token]) {
      const key = `invite-preview:${clientKey(info)}`;
      if (limiter.blocked(key, LIMITS.invitePreview)) limited([key], '查看邀請的次數太多，請稍後再試。');
      limiter.hit(key, LIMITS.invitePreview);
      const { invite, row } = usableInvite(token);
      return json(200, { title: row.title, destination: row.destination, startDate: row.start_date, endDate: row.end_date, inviterName: invite.inviter_name });
    },

    // Per-link revoke by (tripId, inviteId) only (Req 18).
    async revokeInvite(request, url, info, [tripId, inviteId]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      tx(() => {
        user = requireExpectedUser(request, body.expectedUserId);
        const access = requireInviter(tripAccess(user, tripId));
        const invite = ID.test(inviteId) ? q.activeInviteById.get(inviteId, tripId, clock()) : null;
        if (!invite) fail(404, '邀請連結無效或已過期。');
        if (invite.created_by !== user.id && !access.canManage) fail(403, '只有建立連結的人、主辦人或管理員可以撤銷邀請。');
        q.revokeInviteById.run(clock(), inviteId, tripId);
        audit(user.username, 'invite.revoke', `trip:${tripId}`);
      });
      return json(200, { revoked: true });
    },

    async joinInvite(request, url, info, [token]) {
      requireJsonType(request);
      let user = requireUser(request);
      const body = await readJson(request);
      if (typeof body.name !== 'string' || (body.role !== undefined && typeof body.role !== 'string')) fail(400, '請填寫名字或暱稱。');
      const tripId = tx(() => {
        user = requireUser(request);
        const { invite, row } = resolveInvite(token);
        if (inTrip(row, user.id)) return row.id;
        if (invite.used_at !== null) fail(404, '邀請連結無效或已過期。');
        addMemberInTx(row, user.id, body.name, body.role ?? '');
        consumeInTx(invite, user.id);
        audit(user.username, 'invite.join', `trip:${row.id}`);
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
      if (needsSetup()) fail(409, '請先完成管理員設定。');
      const body = await readJson(request);
      const username = validateUsername(body.username), displayName = validateDisplayName(body.displayName);
      validatePassword(body.password);
      const name = body.name ?? displayName, role = body.role ?? '';
      if (typeof name !== 'string' || typeof role !== 'string') fail(400, '請填寫名字或暱稱。');
      usableInvite(token); // cheap 404 before the expensive hash
      if (q.userByName.get(username)) fail(409, '這個帳號名稱已被使用。');
      const hash = await hashPassword(body.password);
      const { user, tripId } = tx(() => {
        if (q.userByName.get(username)) fail(409, '這個帳號名稱已被使用。');
        // Re-check: the invite may have expired, been used, or its trip deleted while hashing.
        const { invite, row } = usableInvite(token);
        const id = randomUUID();
        q.insertUser.run(id, username, displayName, 'member', hash, clock());
        addMemberInTx(row, id, name, role);
        consumeInTx(invite, id);
        audit(username, 'register.invite', `user:${username}`);
        audit(username, 'invite.join', `trip:${row.id}`);
        return { user: q.userById.get(id), tripId: row.id };
      });
      return startSession(request, info, user, { tripId });
    },

    adminUsers(request) {
      requireAdmin(request);
      return json(200, { users: q.listUsers.all().map(u => ({ ...publicUser(u), deleted: u.deleted_at !== null, tripCount: u.trip_count })) });
    },

    async adminPatchUser(request, url, info, [userId]) {
      requireJsonType(request);
      requireAdmin(request);
      const body = await readJson(request);
      const user = tx(() => {
        const admin = requireAdmin(request);
        const target = ID.test(userId) ? q.userById.get(userId) : null;
        if (!target) fail(404, '找不到這個帳號。');
        if (target.deleted_at !== null) fail(409, '這個帳號已刪除。');
        const displayName = body.displayName === undefined ? target.display_name : validateDisplayName(body.displayName);
        const role = body.role === undefined ? target.role : body.role;
        if (!ROLES.includes(role)) fail(400, '角色必須是 admin 或 member。');
        if (target.role === 'admin' && role !== 'admin') {
          if (target.id === admin.id) fail(403, '不能移除自己的管理員權限。');
          if (q.activeAdmins.get().n <= 1) fail(409, '至少需要保留一位管理員。');
        }
        q.updateUser.run(displayName, role, target.id);
        // Demotion: revoke links for trips where the account is neither owner nor member (Req 16.9).
        if (target.role === 'admin' && role === 'member') q.revokeInvitesWithoutRights.run(clock(), target.id, target.id, target.id);
        audit(admin.username, 'user.update', `user:${target.username}`);
        return q.userById.get(target.id);
      });
      return json(200, { user: { ...publicUser(user), deleted: false } });
    },

    async adminDeleteUser(request, url, info, [userId]) {
      requireJsonType(request);
      requireAdmin(request);
      const body = await readJson(request);
      tx(() => {
        const admin = requireAdmin(request);
        const target = ID.test(userId) ? q.userById.get(userId) : null;
        if (!target) fail(404, '找不到這個帳號。');
        if (target.deleted_at !== null) fail(409, '這個帳號已刪除。');
        if (body.confirmUsername !== target.username) fail(400, '請輸入要刪除的帳號名稱以確認。');
        if (target.id === admin.id) fail(403, '不能刪除自己的帳號。');
        if (target.role === 'admin' && q.activeAdmins.get().n <= 1) fail(409, '至少需要保留一位管理員。');
        const at = clock();
        q.softDelete.run(at, target.id);
        q.deleteUserSessions.run(target.id);
        q.revokeInvitesBy.run(at, target.id);
        const touched = new Map();
        const load = tripId => {
          if (!touched.has(tripId)) { const row = q.anyTripById.get(tripId); touched.set(tripId, { row, state: JSON.parse(row.state_json), ownerId: row.owner_id }); }
          return touched.get(tripId);
        };
        for (const { trip_id, person_id } of q.tripsOfMember.all(target.id)) {
          detachPerson(load(trip_id).state, person_id);
          q.deleteMember.run(trip_id, target.id);
        }
        for (const { id } of q.ownedTrips.all(target.id)) {
          const entry = load(id);
          if (!q.membership.get(id, admin.id)) {
            const added = addUniqueParticipant(entry.state, admin.display_name, '接手的主辦人');
            entry.state = added.state;
            q.insertMember.run(id, admin.id, added.person.id, at);
          }
          entry.ownerId = admin.id;
        }
        for (const [tripId, entry] of touched) {
          pushEvent(entry.state, '有旅伴帳號已移除，相關分工已解除綁定', `${admin.display_name}（管理員）`);
          persist(entry.row, entry.state, { ownerId: entry.ownerId });
          audit(admin.username, 'trip.reassign', `trip:${tripId}`);
        }
        audit(admin.username, 'user.delete', `user:${target.username}`);
      });
      return json(200, { ok: true });
    },

    getReceiptAi(request, url, info, [tripId]) {
      const user = requireUser(request), access = ledgerAccess(user, tripId);
      if (!access.canEdit) fail(403, '需要旅行編輯權限才能辨識收據。');
      const keyEnabled = receiptAi?.status?.enabled === true;
      const decision = receiptAiDecision({ policy: receiptAiPolicy().value, role: user.role, canEdit: true, keyEnabled });
      if (decision === 'allow') return json(200, receiptAi.status);
      return json(200, { enabled: false, provider: 'OpenAI', modelId: '', maxImageBytes: AI_IMAGE_LIMIT, disabledReason: decision === 'unconfigured' ? 'unconfigured' : 'policy' });
    },
    async recognizeReceiptAi(request, url, info, [tripId]) {
      const expected = request.headers.get('x-camping-user-id');
      if (!expected) { requireUser(request); fail(400, '缺少預期登入帳號。'); }
      // The policy is read fresh each time, so a change made while the upload or recognition
      // is in flight is honored at the next authorize() call (Req 11.2, 11.3, 11.8).
      const checkPolicy = user => {
        const decision = receiptAiDecision({ policy: receiptAiPolicy().value, role: user.role, canEdit: true, keyEnabled: true });
        if (decision === 'off') fail(503, 'AI 辨識已由管理員關閉。');
        if (decision === 'admins-only') fail(403, '目前只有管理員可以使用 AI 辨識。');
      };
      const authorize = ({ policy = true } = {}) => {
        const user = requireExpectedUser(request, expected), access = ledgerAccess(user, tripId);
        if (!access.canEdit) fail(403, '需要旅行編輯權限才能辨識收據。');
        if (policy) checkPolicy(user);
        return user;
      };
      const user = authorize({ policy: false });
      if (request.headers.get('x-receipt-consent') !== 'openai-v1') fail(400, '請先同意將這張收據照片送到 OpenAI。');
      checkPolicy(user);
      if (!receiptAi?.status?.enabled) fail(503, 'AI 辨識尚未設定，請聯絡管理員。');
      const type = (request.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!['image/jpeg', 'image/png'].includes(type)) fail(415, '請傳送 JPEG 或 PNG 圖片。');
      if (Number(request.headers.get('content-length')) > AI_IMAGE_LIMIT) fail(413, 'AI 圖片超過 3.5 MiB。');
      // Concurrency stays in memory (Req 18.8); the per-user, UTC day, and UTC month counts live in the Accounts_DB.
      if (aiActive.has(user.id) || aiActive.size >= 2) fail(429, 'AI 辨識次數或同時執行數已達上限，請稍後再試。');
      const controller = new AbortController();
      aiActive.set(user.id, controller);
      const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(70000)]);
      try {
        const bytes = await readLimitedBytes(request, AI_IMAGE_LIMIT, signal);
        validateAiImage(bytes, type);
        authorize();
        if (signal.aborted) fail(408, '已取消這次辨識。');
        // Counted only after the policy allows and the image passes, right before the OpenAI call (Req 18.3, 18.12).
        const reservation = reserveAiCall(user.id, tripId);
        let usage = null, result;
        try {
          result = await receiptAi.recognize(bytes, type, { signal, onUsage: u => { usage = u; } });
          settleAiCall(reservation, 'success', usage, request, url);
        } catch (error) {
          settleAiCall(reservation, isAiTimeout(error) ? 'timeout' : 'error', usage, request, url);
          throw error;
        }
        if (closed || signal.aborted) fail(408, '已取消這次辨識。');
        // PBN re-check; a refusal here keeps the settled usage row because the call was made (Req 11.8, 18.13).
        authorize();
        return json(200, result);
      } finally { aiActive.delete(user.id); }
    },

    getLedger(request, url, info, [tripId]) {
      const access = ledgerAccess(requireUser(request), tripId);
      return json(200, ledgerEnvelope(access, readLedgerRow(q.ledgerByTrip.get(tripId))));
    },

    async putLedger(request, url, info, [tripId]) {
      requireJsonType(request);
      requireUser(request);
      const body = await readJson(request);
      validateLedgerBody(body);
      const hash = requestHash(body);
      const result = tx(() => {
        const user = requireExpectedUser(request, body.expectedUserId);
        const access = ledgerAccess(user, tripId);
        const row = q.ledgerByTrip.get(tripId);
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
        if (!row) q.insertLedger.run(tripId, JSON.stringify(ledger), JSON.stringify(requests), user.id, at);
        else if (q.updateLedger.run(JSON.stringify(ledger), JSON.stringify(requests), user.id, at, tripId, current.revision).changes !== 1) fail(409, '帳本已被其他人更新，你的草稿仍保留；請重新載入後再儲存。');
        audit(user.username, 'trip.ledger', `trip:${tripId}`);
        return ledgerEnvelope(access, readLedgerRow(q.ledgerByTrip.get(tripId)));
      });
      return json(200, result);
    },

    deleteTrip(request, url, info, [tripId]) { return softDeleteTrip(request, tripId, false); },
    adminDeleteTrip(request, url, info, [tripId]) { return softDeleteTrip(request, tripId, true); },

    adminAudit(request) {
      requireAdmin(request);
      return json(200, { events: q.listAudit.all().map(e => ({ at: new Date(e.at).toISOString(), actor: e.actor, action: e.action, target: e.target })) });
    },

    adminSettings(request) {
      requireAdmin(request);
      return json(200, settingsBody());
    },

    // Receipt AI usage for the current UTC day and month plus the configured limits (Req 18.6).
    // `pending` rows count as requests with their recorded tokens (0).
    adminReceiptAiUsage(request) {
      requireAdmin(request);
      const at = clock();
      let day, month;
      try { day = usagePeriod(utcDayStart(at)); month = usagePeriod(utcMonthStart(at)); }
      catch { fail(503, AI_UNAVAILABLE); }
      return json(200, {
        day, month,
        limits: { perUser: aiCost.perUser, perUserWindowMinutes: PER_USER_WINDOW_MS / 60000, daily: aiCost.daily, monthly: aiCost.monthly },
        model: { id: aiCost.modelId, imageDetail: aiCost.imageDetail, maxCompletionTokens: aiCost.maxCompletionTokens }
      });
    },

    // Unacknowledged Security_Alerts newest first and the 200 most recent Failed_Login_Events (Req 23.8, 23.11, 23.12).
    adminSecurity(request) {
      requireAdmin(request);
      const isoAt = ms => new Date(ms).toISOString();
      return json(200, {
        unacknowledged: securityEvents.unacknowledgedCount(),
        alerts: securityEvents.listAlerts().map(a => ({
          id: a.id, at: isoAt(a.at), kind: a.kind, username: a.username, client: a.client, count: a.count,
          windowStart: isoAt(a.windowStart), windowEnd: isoAt(a.windowEnd)
        })),
        events: securityEvents.listEvents().map(e => ({ at: isoAt(e.at), username: e.username, client: e.client, reason: e.reason }))
      });
    },

    // The UPDATE only matches an unacknowledged alert, so an unknown, malformed, or repeated ID gets 404
    // and the rollback leaves no audit row (Req 23.10, 23.14).
    async adminAcknowledgeAlert(request, url, info, [alertId]) {
      requireJsonType(request);
      requireAdmin(request);
      await readJson(request);
      const unacknowledged = tx(() => {
        const admin = requireAdmin(request);
        if (!securityEvents.acknowledge(alertId, admin.username, clock())) fail(404, '找不到這個警示，或已經確認過。');
        audit(admin.username, 'security.alert.ack', `alert:${alertId}`);
        return securityEvents.unacknowledgedCount();
      });
      return json(200, { acknowledged: true, unacknowledged });
    },

    async adminPatchSettings(request) {
      requireJsonType(request);
      requireAdmin(request);
      const body = await readJson(request);
      const value = body?.receiptAiPolicy;
      if (!RECEIPT_AI_POLICIES.includes(value)) fail(400, '收據 AI 政策必須是 all、admins 或 off。');
      tx(() => {
        const admin = requireAdmin(request);
        q.upsertSetting.run(RECEIPT_AI_KEY, value, clock(), admin.username);
        audit(admin.username, 'settings.receipt-ai', `receiptAiPolicy:${value}`);
      });
      return json(200, settingsBody());
    }
  };

  const table = [
    [/^\/api\/session$/, { GET: routes.getSession }],
    // Published_Mode has no web first-admin setup: the path falls through to the standard 404 (Req 8.2).
    ...(published ? [] : [[/^\/api\/setup$/, { POST: routes.setup }]]),
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
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
    try {
      if (closed) fail(503, '服務已關閉。');
      // Every OPTIONS to the API, known path or not, gets 405 with no handler and no cookie (Req 12.3, 12.4).
      if (request.method === 'OPTIONS') return errorResponse(405, '不支援這個操作。');
      const given = info || {};
      // Request context from server/http.js; without it, fall back to today's request-URL derivation.
      const ctx = {
        ...given,
        expectedOrigin: typeof given.expectedOrigin === 'string' ? given.expectedOrigin : url.origin,
        secureCookie: typeof given.secureCookie === 'boolean' ? given.secureCookie : url.protocol === 'https:'
      };
      for (const [pattern, methods] of table) {
        const match = url.pathname.match(pattern);
        if (!match) continue;
        const route = methods[request.method];
        if (!route) return errorResponse(405, '不支援這個操作。', [['Allow', Object.keys(methods).join(', ')]]);
        if (request.method !== 'GET' && request.headers.get('origin') !== ctx.expectedOrigin) fail(403, '請求來源不被允許。');
        if (request.method !== 'GET' && request.headers.get('sec-fetch-site') === 'cross-site') fail(403, '不接受跨站請求。');
        let params;
        try { params = match.slice(1).map(decodeURIComponent); } catch { fail(400, '網址格式不正確。'); }
        return await route(request, url, ctx, params);
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
    needsSetup,
    createFirstAdmin,
    resetPassword,
    receiptAiPolicy,
    // A future notifier (for example a LINE webhook) attaches here without touching alert detection (Req 23.16).
    registerAlertNotifier(notifier) { alertDispatcher.register(notifier); },
    close() { if (!closed) { closed = true; for (const controller of aiActive.values()) controller.abort(); aiActive.clear(); for (const statement of Object.values(q)) statement.finalize(); db.close(); } }
  };
}

export { HttpError, RateLimiter, validateUsername, validateDisplayName, validatePassword, hashPassword, verifyPassword, requireJsonType };
