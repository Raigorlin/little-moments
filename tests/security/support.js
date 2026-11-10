// 安全測試套件共用工具（Requirement 7.6、10.1–10.10；design.md Components §8）。
//
// 只對 CAMPING_SECURITY_BASE_URL 指定的 Test_Environment 發送請求；未設定時明確失敗，不提供預設值，
// 避免誤對真實環境執行（套件會註冊合成帳號並寫入合成資料）。
//
// 環境變數：
//   CAMPING_SECURITY_BASE_URL         必填。Test_Environment 的 base URL，例如 http://app.lm-dast.internal:8080。
//                                     其 host 部分即每個請求的 Host 標頭與正確的 Origin。
//   CAMPING_SECURITY_CONNECT_ADDRESS  選填。實際建立 TCP 連線的 IP；未設定時解析 base URL 的主機名稱。
//                                     用於 Host 名稱無 DNS 記錄的情況（例如本機以 lm-test.lan 測試、實際連 127.0.0.1）。
//   CAMPING_SECURITY_PROXY_SOURCE     選填。目標 App 的 CAMPING_TRUSTED_PROXIES 所信任的本機來源 IP；設定時，
//                                     標示 via:'proxy' 的請求以此 IP 為 TCP 來源送出（驗證 X-Forwarded-Proto，Req 10.5、9.12）。
//   CAMPING_SECURITY_SETUP_TOKEN      選填。目標尚未建立管理員且要求設定碼時使用（與 App 的 CAMPING_SETUP_TOKEN 相同）
//   CAMPING_SECURITY_ADMIN_USER／_PASSWORD
//                                     選填。目標已有管理員時使用的合成管理員帳號（角色越權的對照組）。
//   CAMPING_SECURITY_REQUIRE_LAN_HOST 選填。設為 1 時要求 base URL 的 Host 名稱不是 loopback（Req 10.10）
//   CHROME_PATH                       XSS 檢查所需的 Chromium／Chrome 可執行檔
//
// HTTP 用戶端的選擇：一般請求使用 node:http／node:https，而不是 fetch。node:http 明確支援以 headers.Host
// 覆寫 Host 標頭並以 host／localAddress 指定實際連線目標與來源位址；fetch 規範把 Host 列為 forbidden header，
// 雖然 Bun 1.4 的 fetch 目前會送出自訂 Host，但這不是可依賴的行為。路徑穿越與 Host 檢查另用 node:net
// 送出原始 HTTP/1.1 請求（rawRequest），確保路徑不被 URL 正規化。
import { randomBytes, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

export const COOKIE = 'ggc_session';
export const SESSION_MAX_AGE = 604800;

function readIpEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  if (net.isIP(raw) === 0) throw new Error(`安全測試環境變數無效 ${name}: must be an IP address literal`);
  return raw;
}

function readBase() {
  const raw = process.env.CAMPING_SECURITY_BASE_URL;
  if (!raw) throw new Error('安全測試環境變數無效 CAMPING_SECURITY_BASE_URL: unset（必須指向 Test_Environment）');
  let url;
  try { url = new URL(raw); } catch { throw new Error('安全測試環境變數無效 CAMPING_SECURITY_BASE_URL: not a URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('安全測試環境變數無效 CAMPING_SECURITY_BASE_URL: protocol must be http or https');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('安全測試環境變數無效 CAMPING_SECURITY_BASE_URL: must be an origin without path, query or credentials');
  }
  return url;
}

export const BASE = readBase();
export const ORIGIN = BASE.origin;
export const PORT = BASE.port || (BASE.protocol === 'https:' ? '443' : '80');
/** 實際 TCP 連線目標（IP 或主機名稱）。 */
export const CONNECT = readIpEnv('CAMPING_SECURITY_CONNECT_ADDRESS') ?? BASE.hostname.replace(/^\[|\]$/g, '');
/** 受信任 proxy 來源 IP；null 表示目標未設定 Trusted_Proxies 或本次不驗證。 */
export const PROXY_SOURCE = readIpEnv('CAMPING_SECURITY_PROXY_SOURCE');

export const isLoopbackHostname = hostname => {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\./.test(h);
};

/** 合成資料用的唯一字串（不含真實個資）。 */
export const unique = prefix => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
export const syntheticPassword = () => `Sec-${randomBytes(18).toString('base64url')}`;

function sourceAddress(via) {
  if (via !== 'proxy') return undefined;
  if (!PROXY_SOURCE) throw new Error('via:"proxy" 需要 CAMPING_SECURITY_PROXY_SOURCE');
  return PROXY_SOURCE;
}

/**
 * 發送 HTTP 請求（node:http／node:https，見檔頭）。Host 標頭一律為 base URL 的 host（可用 host 覆寫）；
 * 非 GET 預設帶正確的 Origin，可用 origin: null 省略或指定其他值；via:'proxy' 以受信任 proxy 來源 IP 連線。
 * 回傳 { status, headers: Headers, text, json, setCookies }。不跟隨轉址。
 */
export function request(path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {}, host = BASE.host, via } = {}) {
  const h = { ...headers, Host: host };
  if (method !== 'GET' && method !== 'HEAD' && origin !== null) h.Origin = origin;
  if (cookie) h.Cookie = `${COOKIE}=${cookie}`;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = String(payload.length); }
  else if (!['GET', 'HEAD'].includes(method) && !('Content-Length' in h)) h['Content-Length'] = '0';
  const target = new URL(path, BASE);
  const lib = BASE.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: CONNECT, port: Number(PORT), method, path: target.pathname + target.search, headers: h,
      localAddress: sourceAddress(via), agent: false, timeout: 15000,
      ...(BASE.protocol === 'https:' ? { servername: net.isIP(BASE.hostname) ? undefined : BASE.hostname, rejectUnauthorized: false } : {}),
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.once('error', reject);
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const out = new Headers();
        const setCookies = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const [k, v] = [res.rawHeaders[i], res.rawHeaders[i + 1]];
          if (k.toLowerCase() === 'set-cookie') setCookies.push(v);
          out.append(k, v);
        }
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: out, text, json, setCookies });
      });
    });
    req.once('timeout', () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    req.once('error', reject);
    req.end(payload ?? undefined);
  });
}

/** 解析 Set-Cookie 中的 ggc_session；回傳 { value, attrs: Map<lowercase name, value|true> } 或 null。 */
export function sessionCookie(setCookies) {
  for (const line of setCookies) {
    const [pair, ...rest] = line.split(';').map(s => s.trim());
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== COOKIE) continue;
    const attrs = new Map();
    for (const part of rest) {
      const i = part.indexOf('=');
      if (i < 0) attrs.set(part.toLowerCase(), true);
      else attrs.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
    }
    return { value: pair.slice(eq + 1), attrs };
  }
  return null;
}

/**
 * 原始 HTTP/1.1 請求（不經 URL 正規化），用於路徑穿越與 Host 檢查。
 * 回傳 { status, headers: Map<lowercase, string>, body }；body 為原始字串（chunked 時含區塊長度行）。
 */
export function rawRequest(target, { method = 'GET', host = BASE.host, headers = {}, via } = {}) {
  return new Promise((resolve, reject) => {
    const port = Number(PORT);
    const hostname = BASE.hostname.replace(/^\[|\]$/g, '');
    const localAddress = sourceAddress(via);
    const socket = BASE.protocol === 'https:'
      ? tls.connect({ host: CONNECT, port, localAddress, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: false })
      : net.connect({ host: CONNECT, port, localAddress });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`raw request timed out: ${method} ${target}`)); }, 15000);
    socket.once(BASE.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', d => chunks.push(d));
    socket.once('error', err => { clearTimeout(timer); reject(err); });
    socket.once('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const head = split < 0 ? text : text.slice(0, split);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const map = new Map();
      for (const line of headerLines) {
        const i = line.indexOf(':');
        if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      resolve({ status, headers: map, body: split < 0 ? '' : text.slice(split + 4) });
    });
  });
}

// ---------- 合成帳號與資料 ----------

let ready = null;
/**
 * 確保目標已完成首次管理員設定（否則無法註冊）。同一個 bun test 程序內只執行一次。
 * - 尚未設定：以隨機密碼建立合成管理員（只保存在記憶體中）。要求設定碼時，先記錄缺少設定碼、
 *   設定碼錯誤與偽造 X-Forwarded-For: 127.0.0.1 三種未授權嘗試的回應（供 TC-SEC-102 驗證 Req 9.1／9.4），
 *   再以 CAMPING_SECURITY_SETUP_TOKEN 建立。
 * - 已設定：若提供 CAMPING_SECURITY_ADMIN_USER／_PASSWORD 則以其登入作為管理員對照組。
 * @returns {Promise<{admin:{username:string,password:string,cookie:string}|null, setupAttempts:object[]|null}>}
 */
export function ensureReady() {
  ready ||= (async () => {
    const session = await request('/api/session');
    if (session.status !== 200) throw new Error(`GET /api/session 回應 ${session.status}`);
    if (!session.json?.needsSetup) {
      const username = process.env.CAMPING_SECURITY_ADMIN_USER, password = process.env.CAMPING_SECURITY_ADMIN_PASSWORD;
      if (!username || !password) return { admin: null, setupAttempts: null };
      const r = await login(username, password);
      if (r.status !== 200 || !r.cookie) throw new Error(`CAMPING_SECURITY_ADMIN_USER 登入失敗（${r.status}）`);
      return { admin: { username, password, cookie: r.cookie }, setupAttempts: null };
    }
    const token = process.env.CAMPING_SECURITY_SETUP_TOKEN;
    const tokenRequired = !!session.json.setupTokenRequired;
    if (tokenRequired && !token) {
      throw new Error('目標尚未建立管理員且要求設定碼：請以 CAMPING_SECURITY_SETUP_TOKEN 提供 Test_Environment 的設定碼');
    }
    if (!tokenRequired && !isLoopbackHostname(BASE.hostname)) {
      throw new Error('目標尚未建立管理員，且非 loopback Host 無法在未啟用設定碼時完成設定：請先以 loopback Host 建立管理員並提供 CAMPING_SECURITY_ADMIN_USER／_PASSWORD');
    }
    const admin = { username: unique('sec-admin'), displayName: '安全測試管理員', password: syntheticPassword() };
    let setupAttempts = null;
    if (tokenRequired) {
      setupAttempts = [];
      for (const [reason, extra, headers] of [
        ['missing_token', {}, {}],
        ['token_mismatch', { setupToken: `${token}x` }, {}],
        ['forged_forwarded_for', {}, { 'X-Forwarded-For': '127.0.0.1' }],
      ]) {
        const r = await request('/api/setup', { method: 'POST', headers, body: { ...admin, ...extra } });
        setupAttempts.push({ reason, status: r.status, sessionIssued: r.setCookies.some(c => /^ggc_session=[^;]+/.test(c)) });
      }
    }
    const r = await request('/api/setup', { method: 'POST', body: { ...admin, ...(token ? { setupToken: token } : {}) } });
    if (![200, 201].includes(r.status)) throw new Error(`首次管理員設定失敗（${r.status}）`);
    const cookie = sessionCookie(r.setCookies)?.value;
    if (!cookie) throw new Error('首次管理員設定回應缺少 Session Cookie');
    return { admin: { username: admin.username, password: admin.password, cookie }, setupAttempts };
  })();
  return ready;
}

/** 註冊一個合成 member，回傳 { user, password, cookie }。 */
export async function registerMember(prefix = 'sec') {
  await ensureReady();
  const username = unique(prefix);
  const password = syntheticPassword();
  const r = await request('/api/register', { method: 'POST', body: { username, displayName: '安全測試旅伴', password } });
  if (r.status >= 300) throw new Error(`註冊合成帳號失敗（${r.status}）`);
  const cookie = sessionCookie(r.setCookies)?.value;
  if (!cookie) throw new Error('註冊回應缺少 Session Cookie');
  return { user: r.json.user, password, cookie };
}

export async function login(username, password) {
  const r = await request('/api/login', { method: 'POST', body: { username, password } });
  return { ...r, cookie: sessionCookie(r.setCookies)?.value ?? null };
}

export const TRIP = { destination: '安全測試營地', startDate: '2026-10-02', endDate: '2026-10-04', description: '', note: '', coverKind: 'camp', status: 'planning' };
export async function createTrip(cookie, title) {
  const r = await request('/api/trips', { method: 'POST', cookie, body: { ...TRIP, title } });
  if (r.status !== 201) throw new Error(`建立合成行程失敗（${r.status}）`);
  return r.json.trip;
}
export async function tripDetail(cookie, id) {
  const r = await request(`/api/trips/${encodeURIComponent(id)}`, { cookie });
  if (r.status !== 200) throw new Error(`讀取合成行程失敗（${r.status}）`);
  return r.json;
}

let pair = null;
/** 兩個互不相干的 member：owner 擁有一個行程，stranger 未受邀。同一程序內共用。 */
export function ownerAndStranger() {
  pair ||= (async () => {
    const owner = await registerMember('sec-owner');
    const stranger = await registerMember('sec-stranger');
    const title = unique('owner-private-trip');
    const trip = await createTrip(owner.cookie, title);
    return { owner, stranger, trip, title };
  })();
  return pair;
}

// 回應中不應出現的資料庫錯誤內容。
export const DB_ERROR_RE = /SQLSTATE|syntax error|postgres|PostgresError|relation "|column "|pg_|unterminated quoted|ERR_POSTGRES|bun:sql/i;

export { randomUUID };
