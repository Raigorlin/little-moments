// Feature: jenkins-cicd-deploy, Property 13: 設定錯誤與啟動訊息不洩漏秘密
// **Validates: Requirements 8.5, 8.7, 9.3**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { parseConfig, redactedSummary, MIN_SETUP_TOKEN_LENGTH } from '../server/config.js';
import { createSetupGuard } from '../server/setup-guard.js';

const RUNS = { numRuns: 200 };
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!@#%^&+='.split('');

// 秘密值以固定前綴開頭，確保不會與變數名稱或原因文字巧合相同
const secretArb = (minLength, maxLength) =>
  fc.array(fc.constantFrom(...CHARS), { minLength, maxLength }).map(a => `Zq9${a.join('')}`);

const bindArb = fc.constantFrom(undefined, '', '127.0.0.1', '::1', '0.0.0.0', '192.168.1.10', 'fd00::5', 'not-an-ip', '999.1.1.1');
const portArb = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 1, max: 65535 }).map(String),
  fc.constantFrom('0', '65536', 'abc', '-1', '80.5'),
);
const hostArb = fc.constantFrom('camp.lan', 'localhost', '192.168.1.10', '[fd00::5]', 'little-moments.home');
const hostsArb = fc.oneof(
  fc.constant(undefined),
  fc.uniqueArray(hostArb, { minLength: 1, maxLength: 5 }).map(a => a.join(',')),
  fc.constantFrom('*', 'camp.lan,,localhost', 'a'.repeat(254), 'bad_host!'),
);
const proxiesArb = fc.constantFrom(undefined, '', '172.18.0.2', '10.0.0.0/8,fd00::/8', '10.0.0.0/33', '*');
const sslArb = fc.constantFrom(undefined, 'disable', 'require', 'verify-full', 'bogus');
const maybe = arb => fc.option(arb, { nil: undefined });

const scenarioArb = fc.record({
  bind: bindArb,
  port: portArb,
  hosts: hostsArb,
  proxies: proxiesArb,
  // 短 token（< 32 字元，觸發 Req 9.3 錯誤）、長 token 或未設定
  token: fc.oneof(fc.constant(undefined), secretArb(5, MIN_SETUP_TOKEN_LENGTH - 4), secretArb(MIN_SETUP_TOKEN_LENGTH, 64)),
  dbPassword: maybe(secretArb(8, 40)),
  dbHost: maybe(fc.constantFrom('db', '10.0.0.3')),
  dbName: maybe(fc.constant('lm')),
  dbUser: maybe(fc.constant('lm_app')),
  dbPort: maybe(fc.constantFrom('5432', '0', 'x')),
  sslmode: sslArb,
  bedrockKey: maybe(secretArb(8, 40)),
});

function buildEnv(s) {
  const env = {
    CAMPING_BIND_ADDRESS: s.bind,
    PORT: s.port,
    CAMPING_ALLOWED_HOSTS: s.hosts,
    CAMPING_TRUSTED_PROXIES: s.proxies,
    CAMPING_SETUP_TOKEN: s.token,
    CAMPING_DATABASE_HOST: s.dbHost,
    CAMPING_DATABASE_NAME: s.dbName,
    CAMPING_DATABASE_USER: s.dbUser,
    CAMPING_DATABASE_PASSWORD: s.dbPassword,
    CAMPING_DATABASE_PORT: s.dbPort,
    CAMPING_DATABASE_SSLMODE: s.sslmode,
    CAMPING_BEDROCK_API_KEY: s.bedrockKey,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

const secretsOf = s => [s.token, s.dbPassword, s.bedrockKey].filter(v => typeof v === 'string');

function expectNoSecrets(text, secrets) {
  for (const secret of secrets) expect(text.includes(secret)).toBe(false);
}

describe('Property 13: 設定錯誤與啟動訊息不洩漏秘密', () => {
  test('parseConfig 錯誤與 redactedSummary 不含秘密，摘要含 bind、port 與完整 Allowed_Hosts', () => {
    fc.assert(fc.property(scenarioArb, s => {
      const env = buildEnv(s);
      const secrets = secretsOf(s);
      const result = parseConfig(env);

      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        for (const e of result.errors) {
          expect(Object.keys(e).sort()).toEqual(['name', 'reason']);
          expect(e.name).toMatch(/^(CAMPING_[A-Z_]+|PORT)$/);
        }
        // 序列化整個錯誤物件與 serve.mjs 實際輸出的格式
        expectNoSecrets(JSON.stringify(result.errors), secrets);
        expectNoSecrets(result.errors.map(e => `設定錯誤 ${e.name}: ${e.reason}`).join('\n'), secrets);
        return;
      }

      const { config } = result;
      const summary = redactedSummary(config);
      expectNoSecrets(summary, secrets);
      expect(summary).toContain(`bind=${config.bindAddress}`);
      expect(summary).toContain(`port=${config.port}`);
      expect(summary).toContain(`allowedHosts=${config.allowedHosts.join(',')}`);
      for (const host of config.allowedHosts) expect(summary).toContain(host);
    }), RUNS);
  });

  test('Setup_Token 長度不足時，parseConfig 與 createSetupGuard 的錯誤都不含 token 值', () => {
    fc.assert(fc.property(
      fc.constantFrom('0.0.0.0', '192.168.1.10', 'fd00::5'),
      secretArb(1, MIN_SETUP_TOKEN_LENGTH - 4),
      (bind, token) => {
        const result = parseConfig({ CAMPING_BIND_ADDRESS: bind, CAMPING_ALLOWED_HOSTS: 'camp.lan', CAMPING_SETUP_TOKEN: token });
        expect(result.ok).toBe(false);
        expect(result.errors.map(e => e.name)).toContain('CAMPING_SETUP_TOKEN');
        expectNoSecrets(JSON.stringify(result.errors), [token]);

        const logged = [];
        let thrown = null;
        try {
          createSetupGuard({ bindAddress: bind, setupToken: token, log: m => logged.push(m) });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).not.toBeNull();
        expectNoSecrets(`${thrown.message}\n${thrown.stack ?? ''}\n${JSON.stringify(thrown)}`, [token]);
        expect(logged).toEqual([]);
      },
    ), RUNS);
  });
});
