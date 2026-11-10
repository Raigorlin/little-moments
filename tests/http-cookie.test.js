// Feature: jenkins-cicd-deploy, Property 22: Session Cookie 屬性
// **Validates: Requirements 10.3, 10.4, 10.5**
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { resolve } from 'node:path';
import { createAccountService, cookieHeader } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { parseCidrList } from '../server/config.js';
import { useTestDatabase, serviceDb } from './support/pg.js';

const root = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const SESSION_MAX_AGE = 604800;
const ADMIN = { username: 'cookie-admin', displayName: '餅乾管理員', password: 'correct horse battery' };

// 將 Set-Cookie 值拆為名稱、值與屬性（屬性名稱保留原始大小寫以便逐字比對）
function parseSetCookie(header) {
  const [pair, ...attrs] = header.split('; ');
  const eq = pair.indexOf('=');
  const flags = new Set(), values = {};
  for (const a of attrs) {
    const i = a.indexOf('=');
    if (i === -1) flags.add(a); else values[a.slice(0, i)] = a.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), flags, values, attrCount: attrs.length };
}

// 驗證 Cookie 屬性：HttpOnly、SameSite=Strict、Path=/、指定 Max-Age，Secure 若且唯若 https
function expectCookie(header, { token, maxAge, secure }) {
  const c = parseSetCookie(header);
  expect(c.name).toBe('ggc_session');
  if (token !== undefined) expect(c.value).toBe(token);
  expect(c.flags.has('HttpOnly')).toBe(true);
  expect(c.values.SameSite).toBe('Strict');
  expect(c.values.Path).toBe('/');
  expect(c.values['Max-Age']).toBe(String(maxAge));
  expect(c.flags.has('Secure')).toBe(secure);
  // 不含其他屬性（例如 Domain、Expires）
  expect(c.attrCount).toBe(secure ? 5 : 4);
  return c;
}

test('Property 22: cookieHeader 屬性固定，Secure 若且唯若協定為 https:', () => {
  const tokenArb = fc.oneof(fc.stringMatching(/^[a-f0-9]{64}$/), fc.constant(''));
  const urlArb = fc.tuple(
    fc.constantFrom('http', 'https'),
    fc.constantFrom('localhost', '127.0.0.1', '[::1]', 'lan.example', '192.168.1.20', '[fd00::1]'),
    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null }),
    fc.constantFrom('/api/login', '/api/logout', '/api/setup', '/api/register')
  ).map(([s, h, p, path]) => new URL(`${s}://${h}${p === null ? '' : `:${p}`}${path}`));
  const maxAgeArb = fc.oneof(fc.constantFrom(SESSION_MAX_AGE, 0), fc.nat({ max: 10 * SESSION_MAX_AGE }));
  fc.assert(fc.property(urlArb, tokenArb, maxAgeArb, (url, token, maxAge) => {
    expectCookie(cookieHeader(url, token, maxAge), { token, maxAge, secure: url.protocol === 'https:' });
  }), { numRuns: 200 });
});

// ---- 端到端：經 createHttpHandler 登入、驗證 Session、登出 ----
const PROXIES = parseCidrList('10.0.0.5,172.18.0.0/16');
const ALLOWED = ['127.0.0.1', 'localhost', '[::1]', 'lan.example', '192.168.1.20'];
let svc, handler;

async function send(method, url, { body, cookie, tcpIp = '127.0.0.1', headers = {}, origin } = {}) {
  const h = new Headers({ host: new URL(url).host, ...headers });
  if (origin) h.set('origin', origin);
  if (cookie) h.set('cookie', cookie);
  if (body !== undefined) h.set('content-type', 'application/json');
  const req = new Request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handler(req, { requestIP: () => ({ address: tcpIp }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
}

const db = useTestDatabase();

beforeAll(async () => {
  const clock = Date.parse('2026-11-04T00:00:00Z');
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clock });
  handler = createHttpHandler({ root, accounts: svc, allowedHosts: ALLOWED, trustedProxies: PROXIES, health: () => true });
  const base = 'http://127.0.0.1:5173';
  const res = await send('POST', base + '/api/setup', { body: ADMIN, origin: base });
  expect(res.status).toBe(200);
  expectCookie(res.setCookie, { maxAge: SESSION_MAX_AGE, secure: false });
});
afterAll(() => svc.close());

// 請求情境：原始協定、主機、連接埠、TCP 來源（是否為 Trusted_Proxies）與 X-Forwarded-Proto
const scenarioArb = fc.record({
  scheme: fc.constantFrom('http', 'https'),
  host: fc.constantFrom(...ALLOWED),
  port: fc.option(fc.constantFrom(80, 443, 5173, 8080), { nil: null }),
  tcpIp: fc.constantFrom('127.0.0.1', '192.168.1.30', '10.0.0.5', '172.18.3.4', '::1'),
  xfp: fc.option(fc.constantFrom('http', 'https', 'HTTPS', ' https ', 'ftp', 'https, http', ''), { nil: null }),
  xff: fc.option(fc.constantFrom('127.0.0.1', '192.168.1.40', '203.0.113.9, 10.0.0.5'), { nil: null })
});

// 參考判定：只有 TCP 來源屬於 Trusted_Proxies 時採信 X-Forwarded-Proto（僅 http/https）
const TRUSTED_TCP = new Set(['10.0.0.5', '172.18.3.4']);
function expectedProtocol({ scheme, tcpIp, xfp }) {
  if (TRUSTED_TCP.has(tcpIp) && xfp !== null) {
    const p = xfp.trim().toLowerCase();
    if (p === 'http' || p === 'https') return p + ':';
  }
  return scheme + ':';
}

test('Property 22: 登入與登出的 Set-Cookie 依有效請求網址協定決定 Secure，登出後 Session 失效', async () => {
  await fc.assert(fc.asyncProperty(scenarioArb, async s => {
    const url = `${s.scheme}://${s.host}${s.port === null ? '' : `:${s.port}`}`;
    const effective = new URL(url);
    effective.protocol = expectedProtocol(s);
    const secure = effective.protocol === 'https:';
    const headers = {};
    if (s.xfp !== null) headers['x-forwarded-proto'] = s.xfp;
    if (s.xff !== null) headers['x-forwarded-for'] = s.xff;
    const opts = { tcpIp: s.tcpIp, headers, origin: effective.origin };

    const login = await send('POST', url + '/api/login', { ...opts, body: { username: ADMIN.username, password: ADMIN.password } });
    expect(login.status).toBe(200);
    const c = expectCookie(login.setCookie, { maxAge: SESSION_MAX_AGE, secure });
    expect(c.value).toMatch(/^[a-f0-9]{64}$/);
    const cookie = `ggc_session=${c.value}`;

    const before = await send('GET', url + '/api/session', { ...opts, cookie });
    expect(before.body.user?.username).toBe(ADMIN.username);

    const logout = await send('POST', url + '/api/logout', { ...opts, cookie });
    expect(logout.status).toBe(200);
    expectCookie(logout.setCookie, { token: '', maxAge: 0, secure });

    // 舊 Cookie 不再被視為已驗證
    const after = await send('GET', url + '/api/session', { ...opts, cookie });
    expect(after.body.user).toBeNull();
  }), { numRuns: 100 });
}, 120000);
