// 安全測試：Session 處理（Requirement 7.6、10.3、10.4、10.5）。
// Cookie 屬性、登出覆寫與登出後原 Session 無法存取受保護資源。
import { describe, expect, test } from 'bun:test';
import { BASE, PROXY_SOURCE, SESSION_MAX_AGE, login, registerMember, request, sessionCookie } from './support.js';

const expectSecureFlag = attrs => {
  // Req 10.5：https 請求網址才加 Secure；http 不加。
  expect(attrs.has('secure')).toBe(BASE.protocol === 'https:');
};

describe('Session 處理', () => {
  test('[TC-SEC-050] Session 處理：註冊與登入設定的 ggc_session 帶 HttpOnly、SameSite=Strict、Path=/、Max-Age=604800', async () => {
    const member = await registerMember('sec-session');
    const r = await login(member.user.username, member.password);
    expect(r.status).toBe(200);
    const cookie = sessionCookie(r.setCookies);
    expect(cookie).not.toBeNull();
    expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);
    expect(cookie.attrs.get('httponly')).toBe(true);
    expect(String(cookie.attrs.get('samesite')).toLowerCase()).toBe('strict');
    expect(cookie.attrs.get('path')).toBe('/');
    expect(cookie.attrs.get('max-age')).toBe(String(SESSION_MAX_AGE));
    expectSecureFlag(cookie.attrs);
    // 每次登入核發新的 token，不重用註冊時的 token。
    expect(cookie.value).not.toBe(member.cookie);
  }, 30000);

  test('[TC-SEC-051] Session 失效：登出以 Max-Age=0 覆寫 Cookie，之後原 Session 被視為未登入', async () => {
    const member = await registerMember('sec-logout');
    const second = await login(member.user.username, member.password);
    expect((await request('/api/trips', { cookie: member.cookie })).status).toBe(200);
    const out = await request('/api/logout', { method: 'POST', body: {}, cookie: member.cookie });
    expect(out.status).toBe(200);
    const cleared = sessionCookie(out.setCookies);
    expect(cleared).not.toBeNull();
    expect(cleared.value).toBe('');
    expect(cleared.attrs.get('max-age')).toBe('0');
    expect(cleared.attrs.get('httponly')).toBe(true);
    expect(String(cleared.attrs.get('samesite')).toLowerCase()).toBe('strict');
    expect(cleared.attrs.get('path')).toBe('/');
    expectSecureFlag(cleared.attrs);
    // 已登出的 Session 對受保護資源一律 401，/api/session 不再回傳使用者。
    for (const path of ['/api/trips', `/api/admin/users`]) expect((await request(path, { cookie: member.cookie })).status).toBe(401);
    expect((await request('/api/session', { cookie: member.cookie })).json.user).toBeNull();
    expect((await request('/api/trips', { method: 'POST', cookie: member.cookie, body: { title: '登出後建立' } })).status).toBe(401);
    // 其他 Session 不受影響（只撤銷該 Session）。
    expect((await request('/api/trips', { cookie: second.cookie })).status).toBe(200);
  }, 30000);

  test('[TC-SEC-052] Session 處理：X-Forwarded-Proto 只在 Trusted_Proxies 來源採信，Secure 只在有效網址為 https 時加上', async () => {
    const member = await registerMember('sec-proto');
    const httpsOrigin = `https://${BASE.host}`;
    if (BASE.protocol === 'http:') {
      // 非受信任來源：X-Forwarded-Proto 被忽略，有效網址仍為 http（Req 9.12、10.5）。
      const forged = await request('/api/login', { method: 'POST', origin: httpsOrigin, headers: { 'X-Forwarded-Proto': 'https' }, body: { username: member.user.username, password: member.password } });
      expect(forged.status).toBe(403);
      expect(sessionCookie(forged.setCookies)).toBeNull();
      const ignored = await request('/api/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: { username: member.user.username, password: member.password } });
      expect(ignored.status).toBe(200);
      expect(sessionCookie(ignored.setCookies).attrs.has('secure')).toBe(false);
    }
    if (!PROXY_SOURCE) return; // 目標未設定 Trusted_Proxies：只驗證上半部
    // 受信任 proxy 來源：X-Forwarded-Proto: https 使有效網址為 https，Origin 須為 https 且 Cookie 帶 Secure。
    const viaProxy = await request('/api/login', { method: 'POST', via: 'proxy', origin: httpsOrigin, headers: { 'X-Forwarded-Proto': 'https' }, body: { username: member.user.username, password: member.password } });
    expect(viaProxy.status).toBe(200);
    const secure = sessionCookie(viaProxy.setCookies);
    expect(secure.attrs.has('secure')).toBe(true);
    expect(secure.attrs.get('httponly')).toBe(true);
    expect(String(secure.attrs.get('samesite')).toLowerCase()).toBe('strict');
    expect(secure.attrs.get('path')).toBe('/');
    expect(secure.attrs.get('max-age')).toBe(String(SESSION_MAX_AGE));
    // 有效網址為 https 時，http 的 Origin 不再相符（Req 10.1）。
    const mismatch = await request('/api/logout', { method: 'POST', via: 'proxy', origin: `http://${BASE.host}`, headers: { 'X-Forwarded-Proto': 'https' }, body: {}, cookie: secure.value });
    expect(mismatch.status).toBe(403);
    const out = await request('/api/logout', { method: 'POST', via: 'proxy', origin: httpsOrigin, headers: { 'X-Forwarded-Proto': 'https' }, body: {}, cookie: secure.value });
    expect(out.status).toBe(200);
    const cleared = sessionCookie(out.setCookies);
    expect(cleared.attrs.get('max-age')).toBe('0');
    expect(cleared.attrs.has('secure')).toBe(true);
    // 受信任來源宣告 http 或無效值（被忽略，維持原本的 http）時不加 Secure。
    for (const proto of BASE.protocol === 'http:' ? ['http', 'ftp'] : []) {
      const r = await request('/api/login', { method: 'POST', via: 'proxy', origin: `http://${BASE.host}`, headers: { 'X-Forwarded-Proto': proto }, body: { username: member.user.username, password: member.password } });
      expect({ proto, status: r.status }).toEqual({ proto, status: 200 });
      expect(sessionCookie(r.setCookies).attrs.has('secure')).toBe(false);
    }
  }, 30000);
});
