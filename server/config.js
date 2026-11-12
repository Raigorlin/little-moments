// 應用程式設定模組（Requirement 8.1、8.2、8.4、8.5、8.7、9.3、9.12、11.8）。
// 全部為純函式：不讀檔、不連網，只依傳入的 env／參數計算結果，便於 property-based test。
// 錯誤訊息只包含變數名稱與原因類別，絕不包含設定值本身（避免洩漏秘密）。
//
// 除部署設定外，也驗證 security-harden 的應用層設定（預設值與驗證規則相同）：
// CAMPING_REGISTRATION、CAMPING_RECEIPT_AI_POLICY 與收據 AI 用量上限（AI_ENV）。
import { isIP } from 'node:net';
import { RECEIPT_AI_POLICIES, REGISTRATION_POLICIES, resolveReceiptAiPolicy, resolveRegistrationPolicy } from './settings.js';

/**
 * 單一設定值無效。`setting` 為變數名稱，`reason` 為原因（不含設定值）。
 * parseConfig 不丟出例外，而是回傳 `{name, reason}` 清單；需要例外的呼叫端（server/ai-cost.js）使用此型別。
 */
export class ConfigError extends Error {
  constructor(setting, reason) {
    super(`${setting}: ${reason}`);
    this.name = 'ConfigError';
    this.setting = setting;
    this.reason = reason;
  }
}

export const DEFAULT_BIND_ADDRESS = '127.0.0.1';
export const DEFAULT_PORT = 5173;
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
export const DEFAULT_DATABASE_PORT = 5432;
export const DEFAULT_DATABASE_SSLMODE = 'disable';
export const DATABASE_SSLMODES = Object.freeze(['disable', 'require', 'verify-full']);
export const MIN_SETUP_TOKEN_LENGTH = 32;
export const MAX_ALLOWED_HOSTS = 32;
export const MAX_HOST_LENGTH = 253;

// 註冊政策（Requirement 26）：允許值定義於 server/settings.js，此處保留匯出以免既有匯入失效。
// CAMPING_REGISTRATION 只是 Registration_Seed；未設定且 Settings_Store 沒有儲存值時為 open。
export { REGISTRATION_POLICIES };
export const DEFAULT_REGISTRATION_POLICY = 'open';

// 收據 AI 用量設定（security-hardening Requirement 18；原 server/ai-cost.js）。
// CAMPING_OPENAI_MODEL_ID／IMAGE_DETAIL／MAX_COMPLETION_TOKENS 是 OpenAI 請求的成本欄位（模型、圖片細節、
// 回覆 token 上限），與用量上限一起組成 AI_Cost_Config，無效值拒絕啟動。
// API 金鑰（CAMPING_OPENAI_API_KEY／CAMPING_OPENAI_API_KEY_FILE）不在此讀取：只有 server/receipt-ai.js 讀取，
// 因此金鑰不會出現在 parseConfig 的結果、redactedSummary、policySummary 或啟動訊息中。
export const AI_ENV = Object.freeze({
  modelId: 'CAMPING_OPENAI_MODEL_ID',
  imageDetail: 'CAMPING_OPENAI_IMAGE_DETAIL',
  maxCompletionTokens: 'CAMPING_OPENAI_MAX_COMPLETION_TOKENS',
  perUser: 'CAMPING_RECEIPT_AI_USER_LIMIT',
  daily: 'CAMPING_RECEIPT_AI_DAILY_LIMIT',
  monthly: 'CAMPING_RECEIPT_AI_MONTHLY_LIMIT'
});
export const AI_COST_DEFAULTS = Object.freeze({
  modelId: 'gpt-6-luna',
  imageDetail: 'high',
  maxCompletionTokens: 6000,
  perUser: 10,
  daily: 100,
  monthly: 1000
});
export const AI_COST_RANGES = Object.freeze({
  maxCompletionTokens: Object.freeze([1, 16000]),
  perUser: Object.freeze([1, 100]),
  daily: Object.freeze([1, 10000]),
  monthly: Object.freeze([1, 100000])
});
export const AI_IMAGE_DETAILS = Object.freeze(['low', 'high', 'auto']);
const AI_MODEL_RE = /^gpt-[A-Za-z0-9._-]{1,80}$/;
const AI_INTEGER_RE = /^[1-9][0-9]*$/;

const REQUIRED_DATABASE_VARS = ['CAMPING_DATABASE_HOST', 'CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD'];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGITS = /^\d+$/;

// ---------------------------------------------------------------------------
// IP 位址解析（內部）：統一轉為位元組陣列，IPv4 為 4 bytes、IPv6 為 16 bytes。

const stripBrackets = value => (value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value);

function parseIPv4Bytes(text) {
  if (isIP(text) !== 4) return null;
  return text.split('.').map(Number);
}

function parseIPv6Bytes(text) {
  if (isIP(text) !== 6 || text.includes('%')) return null;
  let head = text, tail4 = null;
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tail4 = parseIPv4Bytes(text.slice(lastColon + 1));
    if (!tail4) return null;
    head = text.slice(0, lastColon + 1) + '0:0'; // 以兩個 16 位元群組暫代嵌入的 IPv4
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = part => (part === '' ? [] : part.split(':'));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  const bytes = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail4) bytes.splice(12, 4, ...tail4);
  return bytes;
}

/** 解析 IP 字面值（可含 IPv6 方括號）；無效回傳 null。 */
function parseIp(value) {
  if (typeof value !== 'string') return null;
  const text = stripBrackets(value.trim()).toLowerCase();
  const v4 = parseIPv4Bytes(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIPv6Bytes(text);
  if (v6) return { family: 6, bytes: v6 };
  return null;
}

const isMappedV4 = bytes => bytes.length === 16 && bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

function formatIp({ family, bytes }) {
  if (family === 4) return bytes.join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  // RFC 5952：以 :: 壓縮最長（長度 ≥ 2）的連續 0 群組
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map(g => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function maskBytes(bytes, prefix) {
  return bytes.map((b, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return bits === 0 ? 0 : b & ((0xff << (8 - bits)) & 0xff);
  });
}

function prefixMatches(ipBytes, netBytes, prefix) {
  if (ipBytes.length !== netBytes.length) return false;
  const a = maskBytes(ipBytes, prefix), b = maskBytes(netBytes, prefix);
  return a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// 公開 API

/** 127.0.0.0/8、::1、::ffff:127.0.0.0/104 視為 loopback。接受 IPv6 方括號形式。 */
export function isLoopbackAddress(ip) {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.family === 4) return parsed.bytes[0] === 127;
  if (parsed.bytes.slice(0, 15).every(b => b === 0) && parsed.bytes[15] === 1) return true;
  return isMappedV4(parsed.bytes) && parsed.bytes[12] === 127;
}

function isValidHostname(name) {
  if (name.length < 1 || name.length > MAX_HOST_LENGTH) return false;
  return name.split('.').every(label => HOST_LABEL.test(label));
}

/** 正規化 Allowed_Hosts 的單一項目（不含連接埠）；無效回傳 null。 */
function normalizeHostEntry(entry) {
  if (typeof entry !== 'string') return null;
  const value = entry.trim().toLowerCase();
  if (value.length < 1 || value.length > MAX_HOST_LENGTH || value.includes('*')) return null;
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return null;
    const inner = value.slice(1, -1);
    return isIP(inner) === 6 && !inner.includes('%') ? value : null;
  }
  if (isIP(value) === 4) return value;
  if (/^\d+(?:\.\d+)*$/.test(value)) return null; // 形似 IPv4 但無效
  return isValidHostname(value) ? value : null;
}

/**
 * 正規化 Host 標頭：移除 `:port`、轉小寫、保留 IPv6 方括號。無效回傳 null。
 * 未加方括號的 IPv6（含多個冒號）視為無效。
 */
export function normalizeHost(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;
  let host, port = null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      port = rest.slice(1);
    }
  } else {
    const parts = value.split(':');
    if (parts.length > 2) return null;
    host = parts[0];
    if (parts.length === 2) port = parts[1];
  }
  if (port !== null && (!DIGITS.test(port) || port.length > 5 || Number(port) > 65535)) return null;
  return normalizeHostEntry(host);
}

/** Host 標頭正規化後與 Allowed_Hosts 任一項目（不分大小寫）完全相符時為真。 */
export function hostAllowed(hostHeader, allowedHosts) {
  const host = normalizeHost(hostHeader);
  if (host === null || !Array.isArray(allowedHosts)) return false;
  return allowedHosts.some(item => typeof item === 'string' && item.toLowerCase() === host);
}

/**
 * 解析逗號分隔的 IP／CIDR 清單（IPv4 前綴 0..32、IPv6 前綴 0..128）。
 * undefined 或空字串回傳 []；含空項、`*`、無效位址或前綴超界者回傳 null。
 * 回傳的 network 已依前綴遮罩並以正規形式表示；單一 IP 以 /32 或 /128 表示。
 */
export function parseCidrList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return [];
  const result = [];
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item || item.includes('*')) return null;
    const slash = item.indexOf('/');
    const addr = slash < 0 ? item : item.slice(0, slash);
    if (addr.startsWith('[')) return null; // CIDR 不接受方括號
    const parsed = parseIp(addr);
    if (!parsed) return null;
    const max = parsed.family === 4 ? 32 : 128;
    let prefix = max;
    if (slash >= 0) {
      const text = item.slice(slash + 1);
      if (!DIGITS.test(text) || text.length > 3) return null;
      prefix = Number(text);
      if (prefix > max) return null;
    }
    result.push({ family: parsed.family, network: formatIp({ family: parsed.family, bytes: maskBytes(parsed.bytes, prefix) }), prefix });
  }
  return result;
}

/**
 * IP 是否落在任一 CIDR 內。IPv4-mapped IPv6（::ffff:a.b.c.d）同時以 IPv4 形式比對，
 * IPv4 位址也以其 mapped IPv6 形式比對 IPv6 CIDR。
 */
export function ipInCidrs(ip, cidrs) {
  const parsed = parseIp(ip);
  if (!parsed || !Array.isArray(cidrs)) return false;
  const candidates = [parsed];
  if (parsed.family === 6 && isMappedV4(parsed.bytes)) candidates.push({ family: 4, bytes: parsed.bytes.slice(12) });
  if (parsed.family === 4) candidates.push({ family: 6, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...parsed.bytes] });
  return cidrs.some(cidr => {
    const net = cidr && parseIp(cidr.network);
    if (!net || net.family !== cidr.family) return false;
    const max = cidr.family === 4 ? 32 : 128;
    if (!Number.isInteger(cidr.prefix) || cidr.prefix < 0 || cidr.prefix > max) return false;
    return candidates.some(c => c.family === cidr.family && prefixMatches(c.bytes, net.bytes, cidr.prefix));
  });
}

const headerGetter = headers => {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') return name => headers.get(name);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return name => {
    const v = lower[name.toLowerCase()];
    return Array.isArray(v) ? v.join(',') : v ?? null;
  };
};

/**
 * 決定有效用戶端 IP 與協定（Requirement 9.12）。
 * 僅在 TCP 來源 IP 屬於 Trusted_Proxies 時採信 X-Forwarded-For／X-Forwarded-Proto；
 * 其他來源完全忽略這兩個標頭。來源屬於 Trusted_Proxies 時一律 viaProxy=true。
 * X-Forwarded-For 由右往左取第一個不在 Trusted_Proxies 內的位址；該位址無效或不存在時使用 TCP 來源 IP。
 * 選中的項目不是有效 IP 時另標記 forwardedForInvalid=true（server/http.js 以 400 拒絕，沿用 security-harden
 * 較嚴格的規則：代理送來無法解析的用戶端位址時不以代理 IP 代替，避免所有用戶端共用同一個限速鍵）。
 * @returns {{clientIp:string, protocol:string, viaProxy:boolean, forwardedForInvalid:boolean, url:URL}}
 */
export function resolveClient(tcpIp, headers, url, trustedProxies) {
  const original = url instanceof URL ? url : new URL(String(url));
  const clientIp = typeof tcpIp === 'string' ? tcpIp : '';
  if (!ipInCidrs(clientIp, trustedProxies || [])) {
    return { clientIp, protocol: original.protocol, viaProxy: false, forwardedForInvalid: false, url: new URL(original.href) };
  }
  const get = headerGetter(headers);
  let protocol = original.protocol;
  const proto = get('x-forwarded-proto');
  if (typeof proto === 'string') {
    const p = proto.trim().toLowerCase();
    if (p === 'http' || p === 'https') protocol = `${p}:`;
  }
  let resolvedIp = clientIp, forwardedForInvalid = false;
  const xff = get('x-forwarded-for');
  if (typeof xff === 'string') {
    const entries = xff.split(',').map(s => s.trim());
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (parseIp(entry) && ipInCidrs(entry, trustedProxies)) continue;
      if (parseIp(entry)) resolvedIp = stripBrackets(entry);
      else forwardedForInvalid = true;
      break;
    }
  }
  const effective = new URL(original.href);
  if (effective.protocol !== protocol) effective.protocol = protocol;
  return { clientIp: resolvedIp, protocol, viaProxy: true, forwardedForInvalid, url: effective };
}

/**
 * 收據 AI 用量設定（AI_Cost_Config）。驗證順序與 security-harden 的 parseAiCostConfig 相同，
 * 因此 errors[0] 即為其原本會丟出的那一個錯誤。錯誤原因不含設定值。
 * @returns {{aiCost: object|null, errors: {name:string, reason:string}[]}}
 */
export function parseAiCostSettings(env = {}) {
  env = env || {};
  const errors = [];
  const fail = (name, reason) => errors.push({ name, reason });
  const value = { ...AI_COST_DEFAULTS };
  const ok = {};

  const modelRaw = env[AI_ENV.modelId];
  if (!isUnset(modelRaw)) {
    if (typeof modelRaw !== 'string' || !AI_MODEL_RE.test(modelRaw)) fail(AI_ENV.modelId, '必須是 "gpt-" 後接 1 至 80 個英文字母、數字、"."、"_" 或 "-"');
    else value.modelId = modelRaw;
  }
  const detailRaw = env[AI_ENV.imageDetail];
  if (!isUnset(detailRaw)) {
    if (!AI_IMAGE_DETAILS.includes(detailRaw)) fail(AI_ENV.imageDetail, `必須是 ${AI_IMAGE_DETAILS.join('、')} 其中之一`);
    else value.imageDetail = detailRaw;
  }
  const integer = field => {
    const name = AI_ENV[field];
    const raw = env[name];
    ok[field] = true;
    if (isUnset(raw)) return;
    const [min, max] = AI_COST_RANGES[field];
    const text = String(raw);
    const n = AI_INTEGER_RE.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) { ok[field] = false; fail(name, `必須是 ${min} 至 ${max} 的整數`); }
    else value[field] = n;
  };
  integer('maxCompletionTokens');
  integer('perUser');
  integer('daily');
  if (ok.perUser && ok.daily && value.perUser > value.daily) {
    ok.daily = false;
    fail(AI_ENV.daily, `不得小於 ${AI_ENV.perUser}，且不得大於 ${AI_COST_RANGES.daily[1]}`);
  }
  integer('monthly');
  if (ok.daily && ok.monthly && value.daily > value.monthly) {
    fail(AI_ENV.monthly, `不得小於 ${AI_ENV.daily}，且不得大於 ${AI_COST_RANGES.monthly[1]}`);
  }
  return { aiCost: errors.length ? null : Object.freeze(value), errors };
}

const isUnset = value => value === undefined || value === null || value === '';

/**
 * 解析並驗證環境變數。
 * @param {Record<string,string|undefined>} env
 * CAMPING_DATABASE_HOST／NAME／USER／PASSWORD 一律為必填（Req 11.8）；缺少時錯誤逐一列出變數名稱。
 * CAMPING_DB 不是設定欄位，永遠不會被讀取（Req 11.1）。
 * @returns {{ok:true, config:object} | {ok:false, errors:{name:string, reason:string}[]}}
 */
export function parseConfig(env = {}) {
  const errors = [];
  const fail = (name, reason) => errors.push({ name, reason });
  env = env || {};

  // Bind_Address（Req 8.1、8.7）
  let bindAddress = DEFAULT_BIND_ADDRESS;
  const bindRaw = env.CAMPING_BIND_ADDRESS;
  if (!isUnset(bindRaw)) {
    if (typeof bindRaw !== 'string' || isIP(bindRaw) === 0) fail('CAMPING_BIND_ADDRESS', '必須是有效的 IPv4 或 IPv6 位址字面值');
    else bindAddress = bindRaw.toLowerCase();
  }
  const loopbackBind = isLoopbackAddress(bindAddress);

  // PORT（Req 8.1、8.7）
  let port = DEFAULT_PORT;
  const portRaw = env.PORT;
  if (!isUnset(portRaw)) {
    if (typeof portRaw !== 'string' || !DIGITS.test(portRaw) || portRaw.length > 5 || Number(portRaw) < 1 || Number(portRaw) > 65535) fail('PORT', '必須是 1 至 65535 的整數');
    else port = Number(portRaw);
  }

  // Allowed_Hosts（Req 8.2、8.4、8.7）
  let allowedHosts = [...DEFAULT_ALLOWED_HOSTS];
  const hostsRaw = env.CAMPING_ALLOWED_HOSTS;
  if (isUnset(hostsRaw)) {
    if (!loopbackBind) fail('CAMPING_ALLOWED_HOSTS', 'Bind_Address 不是 loopback 位址時必須設定');
  } else if (typeof hostsRaw !== 'string') {
    fail('CAMPING_ALLOWED_HOSTS', '格式無效');
  } else {
    const items = hostsRaw.split(',');
    if (items.length > MAX_ALLOWED_HOSTS) fail('CAMPING_ALLOWED_HOSTS', `項目數不得超過 ${MAX_ALLOWED_HOSTS} 個`);
    else if (items.some(i => i.trim() === '')) fail('CAMPING_ALLOWED_HOSTS', '不得包含空項目');
    else if (items.some(i => i.includes('*'))) fail('CAMPING_ALLOWED_HOSTS', '不得包含萬用字元 *');
    else if (items.some(i => i.trim().length > MAX_HOST_LENGTH)) fail('CAMPING_ALLOWED_HOSTS', `每個項目長度須為 1 至 ${MAX_HOST_LENGTH} 字元`);
    else {
      const normalized = items.map(normalizeHostEntry);
      if (normalized.some(n => n === null)) fail('CAMPING_ALLOWED_HOSTS', '項目須為主機名稱、IPv4 位址或以方括號表示的 IPv6 位址');
      else allowedHosts = [...new Set(normalized)];
    }
  }

  // Setup_Token（Req 9.2、9.3）：僅在非 loopback Bind_Address 時啟用
  let setupTokenMode = 'disabled', setupToken = null;
  const tokenRaw = env.CAMPING_SETUP_TOKEN;
  if (!loopbackBind) {
    if (isUnset(tokenRaw)) setupTokenMode = 'generated';
    else if (typeof tokenRaw !== 'string' || tokenRaw.length < MIN_SETUP_TOKEN_LENGTH) fail('CAMPING_SETUP_TOKEN', `長度不足，至少需要 ${MIN_SETUP_TOKEN_LENGTH} 個字元`);
    else { setupTokenMode = 'provided'; setupToken = tokenRaw; }
  }

  // Trusted_Proxies（Req 9.12）
  const trustedProxies = parseCidrList(env.CAMPING_TRUSTED_PROXIES);
  if (trustedProxies === null) fail('CAMPING_TRUSTED_PROXIES', '每個項目須為 IPv4／IPv6 位址或 CIDR，且不得為空或含 *');

  // Database（Req 11.8）
  let database = null;
  {
    const missing = REQUIRED_DATABASE_VARS.filter(name => isUnset(env[name]) || typeof env[name] !== 'string' || env[name].trim() === '');
    for (const name of missing) fail(name, '缺少必要的資料庫連線設定');
    let dbPort = DEFAULT_DATABASE_PORT;
    const dbPortRaw = env.CAMPING_DATABASE_PORT;
    if (!isUnset(dbPortRaw)) {
      if (typeof dbPortRaw !== 'string' || !DIGITS.test(dbPortRaw) || dbPortRaw.length > 5 || Number(dbPortRaw) < 1 || Number(dbPortRaw) > 65535) fail('CAMPING_DATABASE_PORT', '必須是 1 至 65535 的整數');
      else dbPort = Number(dbPortRaw);
    }
    let sslmode = DEFAULT_DATABASE_SSLMODE;
    const sslRaw = env.CAMPING_DATABASE_SSLMODE;
    if (!isUnset(sslRaw)) {
      if (!DATABASE_SSLMODES.includes(sslRaw)) fail('CAMPING_DATABASE_SSLMODE', `必須是 ${DATABASE_SSLMODES.join('、')} 其中之一`);
      else sslmode = sslRaw;
    }
    if (!missing.length) {
      database = {
        host: env.CAMPING_DATABASE_HOST, port: dbPort, name: env.CAMPING_DATABASE_NAME,
        user: env.CAMPING_DATABASE_USER, password: env.CAMPING_DATABASE_PASSWORD, sslmode,
      };
    }
  }

  // Registration_Seed（Req 26.1、26.3）：open／closed；未設定或空字串時為 null（server/settings.js 解析為 open）。
  // 管理員在介面儲存的值優先於此初始值。
  let registrationPolicySeed = null;
  const registrationRaw = env.CAMPING_REGISTRATION;
  if (!isUnset(registrationRaw)) {
    if (!REGISTRATION_POLICIES.includes(registrationRaw)) fail('CAMPING_REGISTRATION', `必須是 ${REGISTRATION_POLICIES.join('、')} 其中之一`);
    else registrationPolicySeed = registrationRaw;
  }

  // 收據 AI 政策的初始值（security-harden）：all／admins／off；未設定時為 null（server/settings.js 解析為 all）。
  // 管理員在介面儲存的值優先於此初始值。
  let receiptAiPolicySeed = null;
  const receiptRaw = env.CAMPING_RECEIPT_AI_POLICY;
  if (!isUnset(receiptRaw)) {
    if (!RECEIPT_AI_POLICIES.includes(receiptRaw)) fail('CAMPING_RECEIPT_AI_POLICY', `必須是 ${RECEIPT_AI_POLICIES.join('、')} 其中之一`);
    else receiptAiPolicySeed = receiptRaw;
  }

  // 收據 AI 用量上限（AI_Cost_Config）
  const ai = parseAiCostSettings(env);
  for (const e of ai.errors) fail(e.name, e.reason);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: { bindAddress, port, allowedHosts, setupTokenMode, setupToken, trustedProxies, database, registrationPolicySeed, receiptAiPolicySeed, aiCost: ai.aiCost },
  };
}

/** 啟動訊息摘要（Req 8.5）：只含 Bind_Address、連接埠與完整 Allowed_Hosts，不含任何秘密。 */
export function redactedSummary(config) {
  const hosts = Array.isArray(config?.allowedHosts) ? config.allowedHosts.join(',') : '';
  return `bind=${config?.bindAddress} port=${config?.port} allowedHosts=${hosts}`;
}

const POLICY_SOURCES = Object.freeze({ default: 'default', seed: 'CAMPING_RECEIPT_AI_POLICY', stored: 'admin setting' });
const REGISTRATION_SOURCES = Object.freeze({ default: 'default', seed: 'CAMPING_REGISTRATION', stored: 'admin setting' });

/**
 * 啟動時的應用層設定摘要：實際生效的註冊政策與收據 AI 政策及其來源（Req 26.17）。
 * 只由政策值與來源名稱組成，不含秘密。
 * @param {object} config parseConfig 的 config
 * @param {{value:string, source:string}|string} [receiptAiPolicy] 帳號服務回報的實際政策；未提供時依 config 的初始值推算
 * @param {{value:string, source:string}|string} [registrationPolicy] 帳號服務回報的實際註冊政策；未提供時依 config 的初始值推算
 */
export function policySummary(config, receiptAiPolicy, registrationPolicy) {
  const registration = typeof registrationPolicy === 'string'
    ? { value: registrationPolicy, source: 'default' }
    : registrationPolicy ?? resolveRegistrationPolicy(null, config?.registrationPolicySeed ?? null);
  const registrationValue = REGISTRATION_POLICIES.includes(registration?.value) ? registration.value : 'closed';
  const registrationSource = REGISTRATION_SOURCES[registration?.source] ?? 'default';
  const policy = typeof receiptAiPolicy === 'string'
    ? { value: receiptAiPolicy, source: 'default' }
    : receiptAiPolicy ?? resolveReceiptAiPolicy(null, config?.receiptAiPolicySeed ?? null);
  const value = RECEIPT_AI_POLICIES.includes(policy?.value) ? policy.value : 'off';
  const source = POLICY_SOURCES[policy?.source] ?? 'default';
  return `registration=${registrationValue} (${registrationSource}) receiptAiPolicy=${value} (${source})`;
}
