// tests/support/pg.js 的 session 參數與清除查詢（design.md Components §24.5 單元測試；tasks.md 26.1）。
// 不需要 Ephemeral_Database。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_APPLICATION_NAME, TEST_APPLICATION_NAME_PATTERN, TEST_SESSION_TIMEOUTS,
  adminSessionParams, durationMs, randomSchemaName, terminateTestSessions, testSessionParams,
} from './support/pg.js';

const TESTS_DIR = fileURLToPath(new URL('./', import.meta.url));

describe('testSessionParams', () => {
  test('returns search_path, application_name and the three timeouts', () => {
    const schema = randomSchemaName();
    const params = testSessionParams(schema);
    expect(Object.keys(params).sort()).toEqual(['application_name', 'idle_in_transaction_session_timeout', 'lock_timeout', 'search_path', 'statement_timeout']);
    expect(params).toEqual({
      search_path: schema,
      application_name: `lm-test-${schema.slice(2)}`,
      lock_timeout: '30s',
      statement_timeout: '60s',
      idle_in_transaction_session_timeout: '60s',
    });
  });

  test('statement_timeout is longer than lock_timeout, so a lock wait fails with 55P03 first', () => {
    expect(durationMs(TEST_SESSION_TIMEOUTS.statement_timeout)).toBeGreaterThan(durationMs(TEST_SESSION_TIMEOUTS.lock_timeout));
    expect(durationMs('1min')).toBe(60_000);
    expect(durationMs('0')).toBe(0);
    expect(durationMs('soon')).toBeNaN();
  });

  test('application_name has only [a-z0-9_-] and at most 63 bytes for every valid schema name', () => {
    const schemaArb = fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'), minLength: 1, maxLength: 60 }).map(s => `t_${s}`);
    fc.assert(fc.property(schemaArb, schema => {
      const { application_name: name } = testSessionParams(schema);
      expect(name).toMatch(/^[a-z0-9_-]+$/);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
      expect(TEST_APPLICATION_NAME_PATTERN.test(name)).toBe(true);
    }), { numRuns: 200 });
  });

  test('rejects schema names outside TEST_SCHEMA_PATTERN', () => {
    for (const bad of ['public', 't_', 'T_abc', 't_a;DROP', '', null]) expect(() => testSessionParams(bad)).toThrow();
  });

  test('the admin connection gets the timeouts, its own name and no search_path', () => {
    const params = adminSessionParams();
    expect(params).toEqual({ application_name: ADMIN_APPLICATION_NAME, ...TEST_SESSION_TIMEOUTS });
    expect(TEST_APPLICATION_NAME_PATTERN.test(ADMIN_APPLICATION_NAME)).toBe(false);
  });
});

describe('terminateTestSessions', () => {
  test('passes the application_name as a query parameter, not as SQL text', async () => {
    const calls = [];
    const fakeAdmin = (strings, ...values) => { calls.push({ text: strings.join('$?'), values }); return Promise.resolve([]); };
    const name = testSessionParams(randomSchemaName()).application_name;
    await terminateTestSessions(fakeAdmin, name);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([name]);
    expect(calls[0].text).not.toContain(name);
    expect(calls[0].text).toContain('pg_terminate_backend(pid)');
    expect(calls[0].text).toContain('pid <> pg_backend_pid()');
  });

  test('refuses a name that is not a test application_name, without querying', async () => {
    const calls = [];
    const fakeAdmin = (...args) => { calls.push(args); return Promise.resolve([]); };
    for (const bad of [ADMIN_APPLICATION_NAME, '', "lm-test-x' OR '1'='1", `lm-test-${'a'.repeat(56)}`]) {
      await expect(terminateTestSessions(fakeAdmin, bad)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});

// Bun 1.3.14 時發現 expect(<Bun.SQL 查詢>).rejects／.resolves 不會送出查詢，整個測試程序因此停止輸出
// （建置 #8；任務 26.1 的調查）。查詢的錯誤改以 tests/support/pg.js 的 rejectionOf() 取得。
// Bun 1.4.4 上已不重現（任務 28.3），此檢查保留以防回歸。
test('no test passes a lazy Bun.SQL tagged query straight to expect()', () => {
  const offenders = [];
  for (const file of readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.js'))) {
    const lines = readFileSync(`${TESTS_DIR}${file}`, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => { if (/expect\(\s*(?:[\w$]+\.)*[\w$]+\s*`/.test(line)) offenders.push(`${file}:${i + 1}`); });
  }
  expect(offenders).toEqual([]);
});
