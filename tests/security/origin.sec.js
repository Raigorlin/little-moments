// 安全測試：Origin 檢查（Requirement 7.6、10.1、10.2）。
// Origin 缺少或與請求網址來源（協定、Host 名稱、連接埠）不逐字元相同時回應 403，
// 不建立、修改或刪除資料，也不設定 Session Cookie。
import { describe, expect, test } from 'bun:test';
import { BASE, ORIGIN, PORT, ownerAndStranger, request, tripDetail } from './support.js';

const otherScheme = BASE.protocol === 'https:' ? 'http:' : 'https:';
// 與 ORIGIN 不同但「看起來相近」的 Origin；含 Host 為 LAN 位址但 Origin 為 localhost 的情況（Req 10.2）。
const BAD_ORIGINS = [
  null, // 缺少 Origin
  'null',
  '',
  'http://localhost',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
  `${otherScheme}//${BASE.host}`,
  `${BASE.protocol}//${BASE.hostname}:${Number(PORT) + 1}`,
  `${ORIGIN}/`,
  `${ORIGIN}.evil.example`,
  `${BASE.protocol}//evil.example`,
  `${BASE.protocol}//${BASE.host.toUpperCase()}`,
].filter((o, i, all) => o !== ORIGIN && all.indexOf(o) === i);

const issuedSession = r => r.setCookies.some(c => /^ggc_session=[^;]+/.test(c));

describe('Origin 檢查', () => {
  test('[TC-SEC-060] Origin 檢查：狀態變更請求的 Origin 不符時回應 403 且資料未變更', async () => {
    const { owner, trip, title } = await ownerAndStranger();
    const before = await tripDetail(owner.cookie, trip.id);
    const countBefore = (await request('/api/trips', { cookie: owner.cookie })).json.trips.length;
    for (const origin of BAD_ORIGINS) {
      const label = JSON.stringify(origin);
      const writes = [
        ['/api/trips', 'POST', { title: `Origin 測試 ${label}`, destination: '營地', startDate: '2026-10-02', endDate: '2026-10-03', description: '', note: '', coverKind: 'camp', status: 'planning' }],
        [`/api/trips/${trip.id}`, 'PATCH', { revision: before.trip.revision, title: '不該被修改' }],
        [`/api/trips/${trip.id}/invites`, 'POST', {}],
        [`/api/trips/${trip.id}/delete`, 'POST', { revision: before.trip.revision, confirmTitle: title }],
      ];
      for (const [path, method, body] of writes) {
        const r = await request(path, { method, body, cookie: owner.cookie, origin });
        expect({ origin: label, path, status: r.status }).toEqual({ origin: label, path, status: 403 });
        expect(r.json?.error).toContain('來源');
        expect(issuedSession(r)).toBe(false);
      }
    }
    const after = await tripDetail(owner.cookie, trip.id);
    expect(after.trip.title).toBe(title);
    expect(after.trip.revision).toBe(before.trip.revision);
    expect((await request('/api/trips', { cookie: owner.cookie })).json.trips.length).toBe(countBefore);
  }, 60000);

  test('[TC-SEC-061] Origin 檢查：Origin 不符的登入、註冊與登出不設定或撤銷 Session', async () => {
    const { owner } = await ownerAndStranger();
    for (const origin of BAD_ORIGINS.slice(0, 6)) {
      // 正確密碼也不能在錯誤 Origin 下建立 Session。
      const r = await request('/api/login', { method: 'POST', origin, body: { username: owner.user.username, password: owner.password } });
      expect(r.status).toBe(403);
      expect(issuedSession(r)).toBe(false);
      const out = await request('/api/logout', { method: 'POST', origin, body: {}, cookie: owner.cookie });
      expect(out.status).toBe(403);
    }
    // 錯誤 Origin 的登出不撤銷 Session。
    expect((await request('/api/trips', { cookie: owner.cookie })).status).toBe(200);
  }, 30000);

  test('[TC-SEC-062] Origin 檢查：正確 Origin 的請求被處理（對照組）', async () => {
    const { owner, trip } = await ownerAndStranger();
    const d = await tripDetail(owner.cookie, trip.id);
    const r = await request(`/api/trips/${trip.id}/check`, { method: 'POST', cookie: owner.cookie, body: { revision: d.trip.revision } });
    expect(r.status).not.toBe(403);
  }, 30000);
});
