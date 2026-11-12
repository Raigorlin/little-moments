// Tests for server/config.js parseConfig.
// Organized by section so later tasks (e.g. 5.13 "reject public DB path") can add example cases.
import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { parseConfig, DEFAULT_ALLOWED_HOSTS, AI_ENV, AI_COST_DEFAULTS, policySummary, redactedSummary } from '../server/config.js';

const DB_VARS = ['CAMPING_DATABASE_HOST', 'CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD'];

// ---------------------------------------------------------------------------
// Generators. Each generated value carries the oracle facts the test needs.

const unset = fc.constantFrom(undefined, '');

// Bind_Address: { raw, valid, loopback }
const bindArb = fc.oneof(
  unset.map(raw => ({ raw, valid: true, loopback: true })),
  fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)).map(([a, b, c]) => ({ raw: `127.${a}.${b}.${c}`, valid: true, loopback: true })),
  fc.constantFrom('::1', '::FFFF:127.0.0.1', '0:0:0:0:0:0:0:1').map(raw => ({ raw, valid: true, loopback: true })),
  fc.ipV4().filter(ip => !ip.startsWith('127.')).map(raw => ({ raw, valid: true, loopback: false })),
  fc.constantFrom('0.0.0.0', '::', 'fd00::1', '2001:DB8::5', 'fe80::1:2').map(raw => ({ raw, valid: true, loopback: false })),
  fc.constantFrom('localhost', '999.1.1.1', 'abc', '[::1]', '1.2.3', '127.0.0.1:80', ' ').map(raw => ({ raw, valid: false })),
);

// PORT: { raw, valid, value }
const portArb = fc.oneof(
  unset.map(raw => ({ raw, valid: true, value: 5173 })),
  fc.integer({ min: 1, max: 65535 }).map(n => ({ raw: String(n), valid: true, value: n })),
  fc.oneof(
    fc.constantFrom('0', '65536', '99999', '123456', 'abc', '-1', '1.5', '80a', ' 80', '1e3'),
    fc.integer({ min: 65536, max: 10_000_000 }).map(String),
  ).map(raw => ({ raw, valid: false })),
);

const label = fc.stringMatching(/^[a-z](?:[a-z0-9-]{0,10}[a-z0-9])?$/);
const hostnameArb = fc.array(label, { minLength: 1, maxLength: 4 }).map(ls => ls.join('.'));
const randomCase = s => fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length })
  .map(flags => [...s].map((ch, i) => (flags[i] ? ch.toUpperCase() : ch)).join(''));
// Valid host entry: { raw, normalized }
const validHostArb = fc.oneof(
  hostnameArb,
  fc.ipV4(),
  fc.ipV6().map(ip => `[${ip}]`),
).chain(normalized => randomCase(normalized).map(raw => ({ raw, normalized: normalized.toLowerCase() })));

// Allowed_Hosts: { raw, valid, value }
const hostsArb = fc.oneof(
  unset.map(raw => ({ raw, unset: true })),
  fc.array(validHostArb, { minLength: 1, maxLength: 32 }).map(items => ({
    raw: items.map(i => i.raw).join(','), unset: false, valid: true, value: [...new Set(items.map(i => i.normalized))],
  })),
  // Invalid: >32 items, empty item, wildcard, or an item over 253 characters
  fc.oneof(
    fc.array(validHostArb, { minLength: 33, maxLength: 40 }).map(items => items.map(i => i.raw)),
    fc.tuple(fc.array(validHostArb, { maxLength: 5 }), fc.constantFrom('', '*', 'a*.lan', '*.example.com', 'x'.repeat(254)), fc.nat(5))
      .map(([items, bad, pos]) => { const list = items.map(i => i.raw); list.splice(pos % (list.length + 1), 0, bad); return list; }),
  // A lone empty item would join to '' (= unset), so represent it as ',' (two empty items).
  ).map(list => ({ raw: list.join(',') || ',', unset: false, valid: false })),
);

// Setup_Token: { raw, set, length }
const tokenArb = fc.oneof(
  unset.map(raw => ({ raw, set: false })),
  fc.string({ minLength: 1, maxLength: 64 }).map(raw => ({ raw, set: true, length: raw.length })),
);

const dbValueArb = fc.option(fc.stringMatching(/^[A-Za-z0-9_.-]{1,16}$/), { nil: undefined });
const dbArb = fc.tuple(...DB_VARS.map(() => dbValueArb));

const scenarioArb = fc.record({ bind: bindArb, port: portArb, hosts: hostsArb, token: tokenArb, db: dbArb });

function buildEnv({ bind, port, hosts, token, db }) {
  const env = {};
  const put = (name, value) => { if (value !== undefined) env[name] = value; };
  put('CAMPING_BIND_ADDRESS', bind.raw);
  put('PORT', port.raw);
  put('CAMPING_ALLOWED_HOSTS', hosts.raw);
  put('CAMPING_SETUP_TOKEN', token.raw);
  DB_VARS.forEach((name, i) => put(name, db[i]));
  return env;
}

// Independent oracle derived from Property 12 / Requirements 8.1, 8.2, 8.4, 8.7, 9.3, 11.8.
function expectedErrorNames({ bind, port, hosts, token, db }) {
  const names = new Set();
  if (!bind.valid) names.add('CAMPING_BIND_ADDRESS');
  const loopback = bind.valid ? bind.loopback : true; // invalid bind falls back to the 127.0.0.1 default
  if (!port.valid) names.add('PORT');
  if (hosts.unset ? !loopback : !hosts.valid) names.add('CAMPING_ALLOWED_HOSTS');
  if (!loopback && token.set && token.length < 32) names.add('CAMPING_SETUP_TOKEN');
  // CAMPING_DATABASE_* 一律必填（Req 11.8）
  DB_VARS.forEach((name, i) => { if (db[i] === undefined) names.add(name); });
  return names;
}

describe('parseConfig', () => {
  // Feature: jenkins-cicd-deploy, Property 12: 應用程式設定解析
  // **Validates: Requirements 8.1, 8.2, 8.4, 8.7, 9.3, 11.8**
  test('Property 12: config parsing accepts exactly valid environments and reports the invalid variable names', () => {
    fc.assert(fc.property(scenarioArb, scenario => {
      const result = parseConfig(buildEnv(scenario));
      const expected = expectedErrorNames(scenario);

      if (expected.size > 0) {
        expect(result.ok).toBe(false);
        expect(new Set(result.errors.map(e => e.name))).toEqual(expected);
        return;
      }

      expect(result.ok).toBe(true);
      const { config } = result;
      const { bind, port, hosts, token, db } = scenario;
      expect(config.bindAddress).toBe(bind.raw ? bind.raw.toLowerCase() : '127.0.0.1');
      expect(config.port).toBe(port.value);
      expect(config.allowedHosts).toEqual(hosts.unset ? [...DEFAULT_ALLOWED_HOSTS] : hosts.value);
      expect(config.setupTokenMode).toBe(bind.loopback ? 'disabled' : token.set ? 'provided' : 'generated');
      expect(config.database).toMatchObject({ host: db[0], name: db[1], user: db[2], password: db[3], port: 5432, sslmode: 'disable' });
    }), { numRuns: 300 });
  });
});

const DB_ENV = { CAMPING_DATABASE_HOST: 'db', CAMPING_DATABASE_NAME: 'little_moments', CAMPING_DATABASE_USER: 'app', CAMPING_DATABASE_PASSWORD: 'placeholder-password' };

describe('parseConfig examples', () => {
  test('database variables only: loopback defaults', () => {
    const result = parseConfig({ ...DB_ENV });
    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({ bindAddress: '127.0.0.1', port: 5173, allowedHosts: ['127.0.0.1', 'localhost', '[::1]'], setupTokenMode: 'disabled', database: { host: 'db', port: 5432, sslmode: 'disable' } });
  });

  test('empty environment is rejected and lists every database variable (Req 11.8)', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.name).sort()).toEqual([...DB_VARS].sort());
  });

  test('non-loopback bind without Allowed_Hosts is rejected', () => {
    const result = parseConfig({ ...DB_ENV, CAMPING_BIND_ADDRESS: '0.0.0.0' });
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.name)).toEqual(['CAMPING_ALLOWED_HOSTS']);
  });

  // 原 accounts.test.js「service rejects public database locations」的對應案例（任務 5.13）：
  // 設定永遠不會產生檔案型資料庫路徑；CAMPING_DB（含公開目錄下的路徑）不是設定欄位，
  // 也無法取代 CAMPING_DATABASE_* 連線設定（Req 11.1）。
  test('database locations come only from CAMPING_DATABASE_*; CAMPING_DB paths are never used', () => {
    for (const path of ['dist/accounts.sqlite', 'some/public/a.db', ':memory:', 'data/accounts.sqlite']) {
      const onlyPath = parseConfig({ CAMPING_DB: path });
      expect(onlyPath.ok).toBe(false);
      expect(onlyPath.errors.map(e => e.name).sort()).toEqual(['CAMPING_DATABASE_HOST', 'CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_DATABASE_USER']);
      expect(JSON.stringify(onlyPath.errors)).not.toContain(path);

      const result = parseConfig({ ...DB_ENV, CAMPING_DB: path });
      expect(result.ok).toBe(true);
      expect(Object.keys(result.config.database).sort()).toEqual(['host', 'name', 'password', 'port', 'sslmode', 'user']);
      expect(result.config.database).toMatchObject({ host: 'db', port: 5432, name: 'little_moments', user: 'app' });
      expect(JSON.stringify(result.config)).not.toContain(path);
    }
  });

  test('partial database settings list every missing database variable', () => {
    const result = parseConfig({ CAMPING_DATABASE_HOST: 'db' });
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.name).sort()).toEqual(['CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_DATABASE_USER']);
  });
});

// ---------------------------------------------------------------------------
// 應用層設定（自 security-harden 的 deploy-config.js／ai-cost.js 移入，預設值與驗證規則相同）。
// 錯誤只指出變數名稱與原因，不含設定值。

describe('parseConfig app-level settings', () => {
  const errorsOf = env => {
    const result = parseConfig({ ...DB_ENV, ...env });
    expect(result.ok).toBe(false);
    return result.errors;
  };
  const expectOnlyError = (env, name, { ordering = false } = {}) => {
    const errors = errorsOf(env);
    expect(errors.map(e => e.name)).toEqual([name]);
    if (ordering) return errors[0];
    // 原因不含提交的值：同一變數的任何無效值都得到與獨特值 Zq9-… 相同的原因，且該原因不含 Zq9
    const reference = errorsOf({ ...env, [name]: 'Zq9-unique-value' });
    expect(reference.map(e => e.name)).toEqual([name]);
    expect(reference[0].reason).not.toContain('Zq9');
    expect(errors[0].reason).toBe(reference[0].reason);
    return errors[0];
  };

  test('defaults: registration open, no receipt AI policy seed, Requirement 18.1 AI limits', () => {
    const { config } = parseConfig({ ...DB_ENV });
    expect(config.registrationPolicy).toBe('open');
    expect(config.receiptAiPolicySeed).toBeNull();
    expect(config.aiCost).toEqual({ ...AI_COST_DEFAULTS });
    expect(Object.isFrozen(config.aiCost)).toBe(true);
    // 空字串等同未設定
    const empty = parseConfig({ ...DB_ENV, CAMPING_REGISTRATION: '', CAMPING_RECEIPT_AI_POLICY: '', ...Object.fromEntries(Object.values(AI_ENV).map(n => [n, ''])) });
    expect(empty.config).toMatchObject({ registrationPolicy: 'open', receiptAiPolicySeed: null, aiCost: { ...AI_COST_DEFAULTS } });
  });

  test('accepted values are kept as given', () => {
    for (const registration of ['open', 'closed']) expect(parseConfig({ ...DB_ENV, CAMPING_REGISTRATION: registration }).config.registrationPolicy).toBe(registration);
    for (const seed of ['all', 'admins', 'off']) expect(parseConfig({ ...DB_ENV, CAMPING_RECEIPT_AI_POLICY: seed }).config.receiptAiPolicySeed).toBe(seed);
    const { config } = parseConfig({ ...DB_ENV, CAMPING_RECEIPT_AI_USER_LIMIT: '3', CAMPING_RECEIPT_AI_DAILY_LIMIT: '5', CAMPING_RECEIPT_AI_MONTHLY_LIMIT: '8' });
    expect(config.aiCost).toMatchObject({ perUser: 3, daily: 5, monthly: 8 });
  });

  test('invalid registration and receipt AI policy values refuse startup naming only the variable', () => {
    for (const value of ['Open', 'CLOSED', 'invite', 'invites', 'none', ' open', 'closed ']) {
      expect(expectOnlyError({ CAMPING_REGISTRATION: value }, 'CAMPING_REGISTRATION').reason).toContain('open、closed');
    }
    for (const value of ['members', 'All', 'ADMINS', 'none', 'on', ' off', 'admin']) {
      expect(expectOnlyError({ CAMPING_RECEIPT_AI_POLICY: value }, 'CAMPING_RECEIPT_AI_POLICY').reason).toContain('all、admins、off');
    }
  });

  test('invalid AI limits refuse startup naming only the variable', () => {
    for (const [name, value] of [
      ['CAMPING_RECEIPT_AI_USER_LIMIT', '0'], ['CAMPING_RECEIPT_AI_USER_LIMIT', '101'], ['CAMPING_RECEIPT_AI_USER_LIMIT', 'ten'],
      ['CAMPING_RECEIPT_AI_DAILY_LIMIT', '10001'], ['CAMPING_RECEIPT_AI_DAILY_LIMIT', '1.5'],
      ['CAMPING_RECEIPT_AI_MONTHLY_LIMIT', '100001'], ['CAMPING_RECEIPT_AI_MONTHLY_LIMIT', '-1'],
    ]) expectOnlyError({ [name]: value }, name);
    // 順序：USER_LIMIT ≤ DAILY_LIMIT ≤ MONTHLY_LIMIT；違反時指出較後者，原因只提到另一個變數名稱
    const daily = expectOnlyError({ CAMPING_RECEIPT_AI_USER_LIMIT: '20', CAMPING_RECEIPT_AI_DAILY_LIMIT: '15' }, 'CAMPING_RECEIPT_AI_DAILY_LIMIT', { ordering: true });
    expect(daily.reason).toContain('CAMPING_RECEIPT_AI_USER_LIMIT');
    expect(daily.reason).not.toMatch(/\b(15|20)\b/);
    const monthly = expectOnlyError({ CAMPING_RECEIPT_AI_DAILY_LIMIT: '2000' }, 'CAMPING_RECEIPT_AI_MONTHLY_LIMIT', { ordering: true });
    expect(monthly.reason).toContain('CAMPING_RECEIPT_AI_DAILY_LIMIT');
    expect(monthly.reason).not.toMatch(/\b(1000|2000)\b/);
  });

  test('several invalid app-level settings are all reported together with deployment errors', () => {
    const errors = errorsOf({ CAMPING_REGISTRATION: 'invite', CAMPING_RECEIPT_AI_POLICY: 'members', CAMPING_RECEIPT_AI_USER_LIMIT: '0', PORT: '0' });
    expect(errors.map(e => e.name).sort()).toEqual(['CAMPING_RECEIPT_AI_POLICY', 'CAMPING_RECEIPT_AI_USER_LIMIT', 'CAMPING_REGISTRATION', 'PORT']);
  });

  // security-harden 的部署模式變數不是 main 的設定欄位：設定與否都不影響結果（Req 8、9、10 維持 main 的行為）。
  test('security-harden deployment-mode variables are not read', () => {
    const base = parseConfig({ ...DB_ENV }).config;
    const ignored = {
      CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: 'https://www.our-littlemoments.com', CAMPING_LOCAL_EXTRA_HOSTS: 'camp.lan',
      CAMPING_ALLOW_NON_LOOPBACK_BIND: '1', CAMPING_DOCKER_LOCAL_ONLY: '1', HOST: '0.0.0.0', CAMPING_DB: 'data/accounts.sqlite',
    };
    const result = parseConfig({ ...DB_ENV, ...ignored });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual(base);
    // 非法值也不會被檢查
    expect(parseConfig({ ...DB_ENV, CAMPING_PUBLISHED: 'true', HOST: 'not a host', CAMPING_PUBLIC_ORIGIN: 'ftp://x' }).ok).toBe(true);
  });
});

describe('policySummary', () => {
  test('names registration and the effective receipt AI policy with its source, nothing else', () => {
    const { config } = parseConfig({ ...DB_ENV, CAMPING_REGISTRATION: 'closed', CAMPING_RECEIPT_AI_POLICY: 'admins' });
    expect(policySummary(config)).toBe('registration=closed receiptAiPolicy=admins (CAMPING_RECEIPT_AI_POLICY)');
    expect(policySummary(config, { value: 'off', source: 'stored' })).toBe('registration=closed receiptAiPolicy=off (admin setting)');
    expect(policySummary(parseConfig({ ...DB_ENV }).config)).toBe('registration=open receiptAiPolicy=all (default)');
    // 不在允許值內的政策顯示為 off（與 settings.js 的 fail-closed 一致）
    expect(policySummary(config, { value: 'everyone', source: 'stored' })).toBe('registration=closed receiptAiPolicy=off (admin setting)');
  });

  test('never contains secret values from the environment', () => {
    const secrets = { CAMPING_DATABASE_PASSWORD: 'Zq9-db-password-value', CAMPING_SETUP_TOKEN: 'Zq9'.padEnd(40, 'x'), CAMPING_OPENAI_API_KEY: 'sk-test-SECRET-1234567890abcdef' };
    const { config } = parseConfig({ ...DB_ENV, ...secrets, CAMPING_BIND_ADDRESS: '0.0.0.0', CAMPING_ALLOWED_HOSTS: 'camp.lan' });
    const line = `${redactedSummary(config)} ${policySummary(config)}`;
    for (const value of Object.values(secrets)) expect(line).not.toContain(value);
    expect(line).not.toContain('sk-');
  });
});
