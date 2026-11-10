// Feature: jenkins-cicd-deploy, Property 16: 首次管理員設定授權
// **Validates: Requirements 9.1, 9.4, 9.12**
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const ADMIN = { username: 'admin-one', displayName: '管理員', password: 'correct horse battery' };
const LOCAL_BASE = 'http://127.0.0.1:5173';
const LOCAL_INFO = { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false };

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const OTHER_HOSTS = ['192.168.1.10', 'camp.lan', '[fd00::1]', '127.0.0.1.nip.io'];
const LOOPBACK_IPS = ['127.0.0.1', '127.5.6.7', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::ffff:7f00:2'];
const OTHER_IPS = ['192.168.1.20', '10.0.0.5', '128.0.0.1', 'fd00::2', '::ffff:192.168.1.20', '::2'];

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('');
const tokenArb = (min, max) => fc.array(fc.constantFrom(...TOKEN_CHARS), { minLength: min, maxLength: max }).map(a => a.join(''));

// 提交的 token：相符、缺少（省略／空字串／非字串）、不相符
const submittedArb = fc.oneof(
  fc.constant({ kind: 'match' }),
  fc.constantFrom({ kind: 'omit' }, { kind: 'empty' }, { kind: 'non-string' }),
  tokenArb(16, 80).map(value => ({ kind: 'mismatch', value })),
);

const caseArb = fc.record({
  loopbackHost: fc.boolean(),
  hostPick: fc.nat(),
  loopbackIp: fc.boolean(),
  ipPick: fc.nat(),
  viaProxy: fc.boolean(),
  forgeLoopbackClient: fc.boolean(), // 經代理時 X-Forwarded-For 可能聲稱 127.0.0.1
  tokenEnabled: fc.boolean(),
  token: tokenArb(32, 64),
  submitted: submittedArb,
});

async function call(svc, method, path, { body, cookie, info, base }) {
  const headers = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), info);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('setup creates an admin iff (loopback host && loopback TCP IP && !viaProxy) || token matches', async () => {
  await fc.assert(fc.asyncProperty(caseArb, async c => {
    const hosts = c.loopbackHost ? LOOPBACK_HOSTS : OTHER_HOSTS;
    const ips = c.loopbackIp ? LOOPBACK_IPS : OTHER_IPS;
    const host = hosts[c.hostPick % hosts.length];
    const tcpIp = ips[c.ipPick % ips.length];
    const ip = c.viaProxy && c.forgeLoopbackClient ? '127.0.0.1' : tcpIp;
    const info = { ip, tcpIp, viaProxy: c.viaProxy };
    const base = `http://${host}:5173`;

    const setup = createSetupGuard(c.tokenEnabled
      ? { bindAddress: '0.0.0.0', setupToken: c.token, log: () => {} }
      : { bindAddress: '127.0.0.1' });
    await resetTables(db.sql);
    const svc = await createAccountService({ db: serviceDb(db.sql), now: () => Date.parse('2026-11-04T00:00:00Z'), setup });
    try {
      const body = { ...ADMIN };
      const s = c.submitted;
      if (s.kind === 'match') body.setupToken = c.token;
      else if (s.kind === 'empty') body.setupToken = '';
      else if (s.kind === 'non-string') body.setupToken = 12345;
      else if (s.kind === 'mismatch') body.setupToken = s.value;

      const tokenMatches = c.tokenEnabled && s.kind === 'match'
        || (c.tokenEnabled && s.kind === 'mismatch' && s.value === c.token);
      const expected = (c.loopbackHost && c.loopbackIp && !c.viaProxy) || tokenMatches;

      const res = await call(svc, 'POST', '/api/setup', { body, info, base });
      if (expected) {
        expect(res.status).toBe(200);
        expect(res.body.user).toMatchObject({ username: ADMIN.username, role: 'admin' });
        expect((await call(svc, 'GET', '/api/session', { info, base })).body.needsSetup).toBe(false);
        return;
      }

      // 未授權：403，使用者數維持 0
      expect(res.status).toBe(403);
      expect((await call(svc, 'GET', '/api/session', { info, base })).body.needsSetup).toBe(true);

      // 以本機管理員讀取稽核事件：恰一筆 setup.denied，只含原因類別與來源 IP，不含 token
      const local = await call(svc, 'POST', '/api/setup', { body: { ...ADMIN }, info: LOCAL_INFO, base: LOCAL_BASE });
      expect(local.status).toBe(200);
      const events = (await call(svc, 'GET', '/api/admin/audit', { cookie: local.cookie, info: LOCAL_INFO, base: LOCAL_BASE })).body.events;
      const reason = !c.tokenEnabled ? 'non_loopback' : s.kind === 'mismatch' ? 'token_mismatch' : 'missing_token';
      expect(events.filter(e => e.action === 'setup.denied').map(e => e.target)).toEqual([`reason:${reason} ip:${ip}`]);
      const dump = JSON.stringify(events);
      expect(dump).not.toContain(c.token);
      if (s.kind === 'mismatch') expect(dump).not.toContain(s.value);
    } finally {
      svc.close();
    }
  }), { numRuns: 100 });
}, 120_000);

test('Req 9.12: requests via a trusted proxy that forge a loopback client are never authorized without the token', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...LOOPBACK_HOSTS), fc.constantFrom(...LOOPBACK_IPS), fc.boolean(), tokenArb(32, 64),
    async (host, tcpIp, tokenEnabled, token) => {
      const setup = createSetupGuard(tokenEnabled ? { bindAddress: '0.0.0.0', setupToken: token, log: () => {} } : { bindAddress: '127.0.0.1' });
      await resetTables(db.sql);
      const svc = await createAccountService({ db: serviceDb(db.sql), now: () => 0, setup });
      try {
        const base = `http://${host}:5173`;
        const info = { ip: '127.0.0.1', tcpIp, viaProxy: true };
        const res = await call(svc, 'POST', '/api/setup', { body: { ...ADMIN }, info, base });
        expect(res.status).toBe(403);
        expect((await call(svc, 'GET', '/api/session', { info, base })).body.needsSetup).toBe(true);
      } finally {
        svc.close();
      }
    }), { numRuns: 100 });
}, 60_000);
