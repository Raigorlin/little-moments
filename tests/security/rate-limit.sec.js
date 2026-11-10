// 安全測試：登入嘗試限速（Requirement 7.6）。同一帳號於 15 分鐘內連續 5 次登入失敗後，
// 第 6 次嘗試即使密碼正確仍被拒絕（429），且不建立 Session。
import { describe, expect, test } from 'bun:test';
import { login, registerMember } from './support.js';

describe('登入嘗試限速', () => {
  test('[TC-SEC-070] 登入限速：同帳號 5 次失敗後，正確密碼仍回應 429 且不設定 Session', async () => {
    const member = await registerMember('sec-limit');
    for (let i = 0; i < 5; i++) {
      const r = await login(member.user.username, `${member.password}-wrong-${i}`);
      expect(r.status).toBe(401);
      expect(r.cookie).toBeNull();
    }
    const blocked = await login(member.user.username, member.password);
    expect(blocked.status).toBe(429);
    expect(blocked.cookie).toBeNull();
    // 帳號名稱大小寫或前後空白不同，視為同一帳號，同樣被限速。
    const variant = await login(` ${member.user.username.toUpperCase()} `, member.password);
    expect(variant.status).toBe(429);
    expect(variant.cookie).toBeNull();
  }, 60000);
});
