// 安全測試：路徑處理（Requirement 7.6）與所有回應的安全標頭（Requirement 10.6）。
// 以原始 HTTP 請求送出未經 URL 正規化的路徑，確認不回傳靜態資源目錄以外的檔案內容；
// 並確認 200、400、401、403、404、405、421 回應都帶 SECURITY_HEADERS（靜態資源的 Cache-Control 為 no-cache）。
import { describe, expect, test } from 'bun:test';
import { SECURITY_HEADERS } from '../../server/http.js';
import { BASE, rawRequest, request } from './support.js';

// 靜態資源目錄以外檔案的特徵字串（專案原始碼、套件設定、資料庫、系統檔）。
const OUTSIDE_MARKERS = ['"devDependencies"', 'createAccountService', 'createHttpHandler', 'SQLite format 3', 'root:x:0:0', '[boot loader]', '[fonts]', 'CAMPING_DATABASE_PASSWORD'];
const TARGETS = ['package.json', 'server/accounts.js', 'scripts/serve.mjs', 'etc/passwd', 'windows/win.ini'];
const PREFIXES = ['/', '/assets/', '/chunks/', '/demo/', '/assets/x/'];
const CLIMBS = [
  '../', '../../', '../../../../../../',
  '%2e%2e/', '%2e%2e%2f', '%2E%2E%2F', '..%2f', '.%2e/', '%2e./',
  '..%5c', '%2e%2e%5c', '..\\',
  '%252e%252e%252f', '..%252f', '%c0%ae%c0%ae/', '....//',
];

function traversalPaths() {
  const out = new Set();
  for (const prefix of PREFIXES) for (const climb of CLIMBS) for (const target of TARGETS) {
    const depth = climb.repeat(climb.length < 6 ? 4 : 1);
    out.add(`${prefix}${depth}${target.replaceAll('/', climb.includes('%5c') || climb.includes('\\') ? '%5c' : '/')}`);
  }
  out.add('/index.html/../../package.json');
  out.add('/%2e%2e%2f%2e%2e%2fpackage.json%00.js');
  out.add('/assets/..%00/..%00/package.json');
  return [...out];
}

function expectSecurityHeaders(get, { staticAsset = false } = {}, context = '') {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    const expected = staticAsset && name === 'Cache-Control' ? 'no-cache' : value;
    expect({ context, name, value: get(name) }).toEqual({ context, name, value: expected });
  }
}
const fromRaw = r => name => r.headers.get(name.toLowerCase()) ?? null;
const fromFetch = r => name => r.headers.get(name);

describe('路徑處理', () => {
  test('[TC-SEC-080] 路徑穿越：含 ../ 或其編碼形式的路徑不回傳靜態資源目錄以外的檔案內容', async () => {
    const paths = traversalPaths();
    expect(paths.length).toBeGreaterThan(300);
    const problems = [];
    for (const path of paths) {
      const r = await rawRequest(path);
      const leaked = OUTSIDE_MARKERS.filter(m => r.body.includes(m));
      if (leaked.length) problems.push({ path, status: r.status, leaked });
      // 只有符合靜態資源或路由白名單的路徑可能是 200，穿越路徑一律不應成功取得檔案。
      if (r.status === 200 && !r.headers.get('content-type')?.startsWith('text/html')) problems.push({ path, status: r.status, type: r.headers.get('content-type') });
      if (!Number.isInteger(r.status)) problems.push({ path, status: 'no response' });
      else expectSecurityHeaders(fromRaw(r), {}, path);
    }
    expect(problems).toEqual([]);
  }, 180000);

  test('[TC-SEC-081] 路徑穿越：正常靜態資源仍可取得（對照組）', async () => {
    const r = await rawRequest('/favicon.svg');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<svg');
  }, 30000);
});

describe('安全標頭（Req 10.6）', () => {
  test('[TC-SEC-090] 安全標頭：HTML 路由、靜態資源、API 與 400／401／403／404／405 回應都帶完整安全標頭', async () => {
    const cases = [
      ['/login', {}, 200, false],
      ['/favicon.svg', {}, 200, true],
      ['/styles.css', {}, 200, true],
      ['/api/session', {}, 200, false],
      ['/api/trips', {}, 401, false],
      ['/api/trips', { method: 'POST', origin: 'http://evil.example', body: {} }, 403, false],
      ['/does-not-exist', {}, 404, false],
      ['/api/does-not-exist', {}, 404, false],
      ['/login', { method: 'POST', body: {} }, 405, false],
      ['/api/session', { method: 'DELETE' }, 405, false],
      ['/healthz', { method: 'POST' }, 405, false],
      ['/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, 400, false],
    ];
    for (const [path, opts, status, staticAsset] of cases) {
      const r = await request(path, opts);
      const context = `${opts.method ?? 'GET'} ${path}`;
      expect({ context, status: r.status }).toEqual({ context, status });
      expectSecurityHeaders(fromFetch(r), { staticAsset }, context);
    }
    // 無法解碼的路徑 → 400
    const bad = await rawRequest('/%E0%A4%A');
    expect(bad.status).toBe(400);
    expectSecurityHeaders(fromRaw(bad), {}, 'GET /%E0%A4%A');
  }, 60000);

  test('[TC-SEC-091] 安全標頭 Host 檢查：Host 不在 Allowed_Hosts 的請求回應 421 並帶安全標頭，且不處理 API', async () => {
    for (const host of ['evil.example', `evil.example:${BASE.port || 80}`, 'localhost.evil.example', '']) {
      for (const path of ['/login', '/api/session', '/healthz', '/../package.json']) {
        const r = await rawRequest(path, { host });
        expect({ host, path, status: r.status }).toEqual({ host, path, status: 421 });
        expectSecurityHeaders(fromRaw(r), {}, `Host ${host} ${path}`);
        expect(r.body).not.toContain('needsSetup');
        expect(r.headers.has('set-cookie')).toBe(false);
      }
    }
  }, 60000);
});
