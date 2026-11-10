// 安全測試：SQL injection（Requirement 7.6）。注入字串不改變查詢結果、不修改他人資料、回應不含資料庫錯誤內容。
import { describe, expect, test } from 'bun:test';
import { DB_ERROR_RE, createTrip, ownerAndStranger, request, tripDetail } from './support.js';

const PAYLOADS = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "'; DROP TABLE trips; --",
  '" OR ""="',
  "1); DELETE FROM users WHERE ('1'='1",
  "x' UNION SELECT password_hash, username FROM users --",
  '\\\'; SELECT pg_sleep(5); --',
];

describe('SQL injection', () => {
  test('[TC-SEC-001] SQL injection：登入欄位的注入字串一律 401／400，且回應不含資料庫錯誤內容', async () => {
    // 只取前三個 payload：每次失敗都計入登入限速。
    for (const payload of PAYLOADS.slice(0, 3)) {
      const r = await request('/api/login', { method: 'POST', body: { username: payload, password: payload } });
      expect([400, 401]).toContain(r.status);
      expect(r.setCookies.some(c => c.startsWith('ggc_session=') && !c.startsWith('ggc_session=;'))).toBe(false);
      expect(r.text).not.toMatch(DB_ERROR_RE);
    }
  }, 30000);

  test('[TC-SEC-002] SQL injection：行程欄位的注入字串原文保存，不影響他人資料或資料筆數', async () => {
    const { owner, stranger, trip, title } = await ownerAndStranger();
    const strangerBefore = (await request('/api/trips', { cookie: stranger.cookie })).json.trips.length;
    const created = [];
    for (const payload of PAYLOADS) {
      const t = await createTrip(owner.cookie, `注入 ${payload}`.slice(0, 100));
      created.push(t);
      const d = await tripDetail(owner.cookie, t.id);
      expect(d.trip.title).toBe(`注入 ${payload}`.slice(0, 100));
    }
    const patched = await request(`/api/trips/${created[0].id}`, { method: 'PATCH', cookie: owner.cookie, body: { revision: created[0].revision, note: PAYLOADS[2], destination: PAYLOADS[4] } });
    expect(patched.status).toBe(200);
    const after = await tripDetail(owner.cookie, created[0].id);
    expect(after.trip.note).toBe(PAYLOADS[2]);
    expect(after.trip.destination).toBe(PAYLOADS[4]);
    // 查詢結果不變：owner 只看到自己的行程；stranger 的清單筆數不變且看不到 owner 的行程。
    const ownerTrips = (await request('/api/trips', { cookie: owner.cookie })).json.trips;
    expect(ownerTrips.some(t => t.id === trip.id && t.title === title)).toBe(true);
    for (const t of created) expect(ownerTrips.some(x => x.id === t.id)).toBe(true);
    const strangerTrips = (await request('/api/trips', { cookie: stranger.cookie })).json.trips;
    expect(strangerTrips.length).toBe(strangerBefore);
    expect(strangerTrips.some(t => created.some(c => c.id === t.id) || t.id === trip.id)).toBe(false);
  }, 60000);

  test('[TC-SEC-003] SQL injection：路徑參數的注入字串被拒絕且不回傳資料或資料庫錯誤', async () => {
    const { owner, title } = await ownerAndStranger();
    for (const payload of PAYLOADS) {
      const r = await request(`/api/trips/${encodeURIComponent(payload)}`, { cookie: owner.cookie });
      expect([400, 403, 404]).toContain(r.status);
      expect(r.text).not.toContain(title);
      expect(r.text).not.toMatch(DB_ERROR_RE);
      const inv = await request(`/api/invites/${encodeURIComponent(payload)}`, { cookie: owner.cookie });
      expect([400, 404]).toContain(inv.status);
      expect(inv.text).not.toMatch(DB_ERROR_RE);
    }
  }, 30000);
});
