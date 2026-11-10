// 安全測試：未登入存取、跨使用者資料存取、角色越權（Requirement 7.6）。
// 每個案例都確認「被拒絕」與「回應不含受保護資料／資料未被變更」。
import { describe, expect, test } from 'bun:test';
import { ensureReady, ownerAndStranger, request, tripDetail } from './support.js';

describe('未登入存取', () => {
  test('[TC-SEC-020] 未登入存取：未登入請求受保護 API 被拒絕且回應不含受保護資料', async () => {
    const { trip, title } = await ownerAndStranger();
    const reads = ['/api/trips', `/api/trips/${trip.id}`, `/api/trips/${trip.id}/ledger`, '/api/admin/users', '/api/admin/audit'];
    for (const path of reads) {
      const r = await request(path);
      expect([401, 404]).toContain(r.status);
      expect(r.text).not.toContain(title);
    }
    for (const path of ['/api/trips', '/api/admin/users', `/api/trips/${trip.id}`]) expect((await request(path)).status).toBe(401);
    const writes = [
      ['/api/trips', 'POST', { title: '匿名建立' }],
      [`/api/trips/${trip.id}`, 'PATCH', { revision: trip.revision, title: '匿名修改' }],
      [`/api/trips/${trip.id}/invites`, 'POST', {}],
      [`/api/trips/${trip.id}/delete`, 'POST', { revision: trip.revision, confirmTitle: title }],
    ];
    for (const [path, method, body] of writes) {
      const r = await request(path, { method, body });
      expect(r.status).toBe(401);
      expect(r.text).not.toContain(title);
    }
    // 偽造或格式錯誤的 Session Token 同樣視為未登入。
    for (const cookie of ['0'.repeat(64), 'not-a-token', `${'a'.repeat(63)}g`]) {
      expect((await request('/api/trips', { cookie })).status).toBe(401);
    }
  }, 30000);
});

describe('跨使用者資料存取', () => {
  test('[TC-SEC-030] 跨使用者資料存取：一般使用者讀取或修改他人未受邀行程被拒絕，資料未被變更', async () => {
    const { owner, stranger, trip, title } = await ownerAndStranger();
    const before = await tripDetail(owner.cookie, trip.id);
    const attempts = [
      [`/api/trips/${trip.id}`, 'GET'],
      [`/api/trips/${trip.id}/ledger`, 'GET'],
      [`/api/trips/${trip.id}`, 'PATCH', { expectedUserId: stranger.user.id, revision: before.trip.revision, title: '跨帳號修改' }],
      [`/api/trips/${trip.id}`, 'PUT', { expectedUserId: stranger.user.id, revision: before.trip.revision, state: before.state }],
      [`/api/trips/${trip.id}/invites`, 'POST', { expectedUserId: stranger.user.id }],
      [`/api/trips/${trip.id}/delete`, 'POST', { expectedUserId: stranger.user.id, revision: before.trip.revision, confirmTitle: title }],
    ];
    for (const [path, method, body] of attempts) {
      const r = await request(path, { method, body, cookie: stranger.cookie });
      expect([403, 404]).toContain(r.status);
      expect(r.text).not.toContain(title);
    }
    const strangerList = (await request('/api/trips', { cookie: stranger.cookie })).json.trips;
    expect(strangerList.some(t => t.id === trip.id)).toBe(false);
    const after = await tripDetail(owner.cookie, trip.id);
    expect(after.trip.title).toBe(title);
    expect(after.trip.revision).toBe(before.trip.revision);
    expect(after.state).toEqual(before.state);
  }, 30000);
});

describe('角色越權', () => {
  test('[TC-SEC-040] 角色越權：一般使用者呼叫管理員功能被拒絕，目標帳號與行程未被變更', async () => {
    const { owner, stranger, trip, title } = await ownerAndStranger();
    const attempts = [
      ['/api/admin/users', 'GET'],
      ['/api/admin/audit', 'GET'],
      [`/api/admin/users/${owner.user.id}`, 'PATCH', { expectedUserId: stranger.user.id, role: 'admin' }],
      [`/api/admin/users/${stranger.user.id}`, 'PATCH', { expectedUserId: stranger.user.id, role: 'admin' }],
      [`/api/admin/users/${owner.user.id}/delete`, 'POST', { expectedUserId: stranger.user.id, confirmUsername: owner.user.username }],
      [`/api/admin/trips/${trip.id}/delete`, 'POST', { expectedUserId: stranger.user.id, revision: trip.revision, confirmTitle: title }],
    ];
    for (const [path, method, body] of attempts) {
      const r = await request(path, { method, body, cookie: stranger.cookie });
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(owner.user.username);
    }
    // 對照組：管理員（本程序建立或 CAMPING_SECURITY_ADMIN_USER 提供）可以讀取同一個管理員 API。
    const { admin } = await ensureReady();
    if (admin) expect((await request('/api/admin/users', { cookie: admin.cookie })).status).toBe(200);
    // 角色未被提升、owner 帳號與行程仍在。
    expect((await request('/api/session', { cookie: stranger.cookie })).json.user.role).toBe('member');
    expect((await request('/api/session', { cookie: owner.cookie })).json.user.id).toBe(owner.user.id);
    expect((await tripDetail(owner.cookie, trip.id)).trip.title).toBe(title);
  }, 30000);
});
