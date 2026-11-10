// Feature: jenkins-cicd-deploy, Property 21: Origin 檢查
// **Validates: Requirements 10.1, 10.2**
// 以真實的 createAccountService（PostgreSQL Ephemeral_Database 的隔離 schema）接在 createHttpHandler 後方，
// 驗證非 GET 的 API 請求僅在 Origin 與重建後有效請求網址的 origin 逐字元相同時才被處理；
// 否則回應 403、無資料變更且無 Set-Cookie。
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { resolve } from 'node:path';
import { createHttpHandler } from '../server/http.js';
import { createAccountService } from '../server/accounts.js';
import { parseCidrList } from '../server/config.js';
import { useTestDatabase, serviceDb } from './support/pg.js';

const root = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const PASS = 'correct horse battery';
const ALLOWED = ['lan.example', '192.168.1.20', 'localhost', '127.0.0.1'];
// 送出的 Host 標頭（皆在 Allowed_Hosts 內）；含 LAN 名稱、LAN IP 與 loopback，以及不帶連接埠的形式
const HOSTS = ['lan.example:5173', '192.168.1.20:5173', 'localhost:5173', '127.0.0.1:5173', 'lan.example'];
const PROXY_IP = '172.18.0.2';
const trustedProxies = parseCidrList(PROXY_IP);
const LOCAL_INFO = { requestIP: () => ({ address: '127.0.0.1' }) };

let svc, handler, clockMs, adminCookie, fixtureTripId;

// 經由 HTTP 處理器送出請求；Request 建構子不會自動帶 Host，因此明確設定（與 Bun.serve 一致：req.url 由 Host 組成）
async function send(method, path, { host = '127.0.0.1:5173', origin, cookie, body, tcpIp = '127.0.0.1', xfp } = {}) {
  const headers = new Headers({ host });
  if (origin !== undefined) headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  if (xfp !== undefined) headers.set('x-forwarded-proto', xfp);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const req = new Request(`http://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handler(req, { requestIP: () => ({ address: tcpIp }) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
}
// 以正確 Origin 讀取（GET 不檢查 Origin，但帶上無妨）
const read = async path => {
  const res = await send('GET', path, { origin: 'http://127.0.0.1:5173', cookie: adminCookie });
  expect(res.status).toBe(200);
  return res.body;
};
// 資料快照：使用者、稽核、行程列表、固定行程內容與 admin session 是否仍有效
async function snapshot() {
  return {
    users: await read('/api/admin/users'),
    audit: await read('/api/admin/audit'),
    trips: await read('/api/trips'),
    fixture: await read(`/api/trips/${fixtureTripId}`),
    session: await read('/api/session')
  };
}

const card = () => ({ title: 'Origin 測試', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: 'x', note: 'y', coverKind: 'lake', status: 'planning' });

async function loginAdmin() {
  const res = await send('POST', '/api/login', { origin: 'http://127.0.0.1:5173', body: { username: 'admin-one', password: PASS } });
  expect(res.status).toBe(200);
  adminCookie = res.setCookie.split(';')[0];
}

const db = useTestDatabase();

beforeAll(async () => {
  clockMs = Date.parse('2026-11-04T00:00:00Z');
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs });
  handler = createHttpHandler({ root, accounts: svc, allowedHosts: ALLOWED, health: async () => true, trustedProxies });
  // 一次性建立管理員與固定行程（scrypt 很慢，不在每次迭代雜湊）
  const setup = await send('POST', '/api/setup', { origin: 'http://127.0.0.1:5173', body: { username: 'admin-one', displayName: '管理員', password: PASS } });
  expect(setup.status).toBe(200);
  adminCookie = setup.setCookie.split(';')[0];
  const trip = await send('POST', '/api/trips', { origin: 'http://127.0.0.1:5173', cookie: adminCookie, body: card() });
  expect(trip.status).toBe(201);
  fixtureTripId = trip.body.trip.id;
});
afterAll(() => svc.close());

// 會改變狀態的非 GET 操作；Origin 相符時會被實際處理
const OPS = [
  { name: 'logout', method: 'POST', path: () => '/api/logout', body: () => undefined },
  { name: 'login', method: 'POST', path: () => '/api/login', body: () => ({}) },
  { name: 'register', method: 'POST', path: () => '/api/register', body: () => ({}) },
  { name: 'setup', method: 'POST', path: () => '/api/setup', body: () => ({ username: 'admin-two', displayName: 'x', password: PASS }) },
  { name: 'createTrip', method: 'POST', path: () => '/api/trips', body: card },
  { name: 'putTrip', method: 'PUT', path: () => `/api/trips/${fixtureTripId}`, body: () => ({ revision: -1, state: {} }) },
  { name: 'createInvite', method: 'POST', path: () => `/api/trips/${fixtureTripId}/invites`, body: () => ({}) },
  { name: 'deleteTrip', method: 'POST', path: () => `/api/trips/${fixtureTripId}/delete`, body: () => ({}) }
];

// 傳輸情境：直接連線（忽略 X-Forwarded-Proto）或經 Trusted_Proxies 轉送（採信 http/https）
const transportArb = fc.oneof(
  fc.record({ tcpIp: fc.constantFrom('127.0.0.1', '192.168.1.50'), xfp: fc.constantFrom(undefined, 'https', 'http') }),
  fc.record({ tcpIp: fc.constant(PROXY_IP), xfp: fc.constantFrom(undefined, 'https', 'http', 'HTTPS', 'ftp', '') })
);
const effectiveScheme = ({ tcpIp, xfp }) => {
  if (tcpIp !== PROXY_IP || xfp === undefined) return 'http:';
  const p = xfp.trim().toLowerCase();
  return p === 'http' || p === 'https' ? `${p}:` : 'http:';
};

// Origin 變化：依有效 origin 推導，涵蓋缺少、完全相同、不同協定／主機／連接埠、其他 Allowed_Hosts、大小寫、結尾斜線、'null' 與任意字串
const originKindArb = fc.oneof(
  fc.constantFrom('missing', 'exact', 'exact', 'exact', 'scheme', 'port', 'upper', 'slash', 'null', 'evil'),
  fc.constantFrom(...HOSTS).map(h => ({ otherHost: h })),
  fc.string({ maxLength: 30 }).map(s => ({ raw: s }))
);
function buildOrigin(kind, scheme, host) {
  const exact = new URL(`${scheme}//${host}`).origin;
  if (typeof kind === 'object') {
    if ('otherHost' in kind) return new URL(`${scheme}//${kind.otherHost}`).origin;
    return kind.raw;
  }
  switch (kind) {
    case 'missing': return undefined;
    case 'exact': return exact;
    case 'scheme': return new URL(`${scheme === 'https:' ? 'http:' : 'https:'}//${host}`).origin;
    case 'port': return `${scheme}//${host.split(':')[0]}:5174`;
    case 'upper': return exact.toUpperCase();
    case 'slash': return exact + '/';
    case 'null': return 'null';
    case 'evil': return `${scheme}//attacker.example`;
  }
}

test('Property 21: 非 GET API 請求僅在 Origin 與有效請求網址 origin 完全相同時處理', async () => {
  let accepted = 0, rejected = 0;
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...OPS), fc.constantFrom(...HOSTS), transportArb, originKindArb,
    async (op, host, transport, kind) => {
      clockMs += 16 * 60000; // 每次迭代跨過 15 分鐘限速時間窗，避免限速干擾判定
      const scheme = effectiveScheme(transport);
      const expectedOrigin = new URL(`${scheme}//${host}`).origin;
      const origin = buildOrigin(kind, scheme, host);
      // 部分 Origin 值不是合法標頭（例如含換行），Headers 會拒絕；略過
      try { if (origin !== undefined) new Headers({ origin }); } catch { fc.pre(false); }
      const shouldProcess = origin === expectedOrigin;
      const before = shouldProcess ? null : await snapshot();
      const res = await send(op.method, op.path(), { host, origin, cookie: adminCookie, body: op.body(), ...transport });
      if (shouldProcess) {
        accepted++;
        // 已處理：不會出現 Origin 拒絕訊息（其他 403 例如權限不屬於此類，但此處操作皆由 admin 發出）
        expect(res.status === 403 && res.body?.error === '請求來源不被允許。').toBe(false);
        // 接受的登出／刪除會改變固定資料，重新建立以維持後續快照比較
        if (op.name === 'logout') await loginAdmin();
        if (op.name === 'deleteTrip' && res.status === 200) {
          const trip = await send('POST', '/api/trips', { origin: 'http://127.0.0.1:5173', cookie: adminCookie, body: card() });
          expect(trip.status).toBe(201);
          fixtureTripId = trip.body.trip.id;
        }
      } else {
        rejected++;
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: '請求來源不被允許。' });
        expect(res.setCookie).toBeNull();
        expect(await snapshot()).toEqual(before);
      }
    }
  ), { numRuns: 150 });
  // 確保兩種結果都有被實際涵蓋
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
}, 120000);

test('Property 21 範例：Host 為 LAN 位址但 Origin 為 http://localhost 時拒絕且資料不變', async () => {
  clockMs += 16 * 60000;
  const before = await snapshot();
  for (const origin of ['http://localhost:5173', 'http://localhost', 'http://127.0.0.1:5173']) {
    const res = await send('POST', '/api/trips', { host: 'lan.example:5173', origin, cookie: adminCookie, body: card() });
    expect(res.status).toBe(403);
    expect(res.setCookie).toBeNull();
  }
  expect(await snapshot()).toEqual(before);
  const ok = await send('POST', '/api/trips', { host: 'lan.example:5173', origin: 'http://lan.example:5173', cookie: adminCookie, body: card() });
  expect(ok.status).toBe(201);
});
