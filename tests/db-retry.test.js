// Feature: jenkins-cicd-deploy, Property 26: 啟動重連排程
// **Validates: Requirements 11.5**
// 不需真實 Database：以假的 create/sql、假時鐘 now 與只推進時鐘的 sleep 驗證重連排程。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  DatabaseConnectError, RETRY_MAX_MS, RETRY_MIN_MS, RETRY_TOTAL_MS, connectWithRetry, retrySchedule,
} from '../server/db/connect.js';

const RUNS = { numRuns: 100 };

// random() 值域含邊界與異常值（1、負數、NaN），驗證排程仍落在 1–5 秒內
const randomValue = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
  fc.constantFrom(0, 0.999999999, 1, -0.5, Number.NaN, Number.POSITIVE_INFINITY),
);
const randomSeq = fc.array(randomValue, { minLength: 1, maxLength: 64 });
const cycling = seq => { let i = 0; return () => seq[i++ % seq.length]; };

// 密碼一律含小寫與 '-'，不可能被 safeCode 的 /^[A-Z0-9_]+$/ 當成錯誤代碼保留
const password = fc.string({ minLength: 8, maxLength: 40 }).map(s => `pw-${s}`);
const database = fc.record({
  host: fc.oneof(fc.constantFrom('db', 'localhost', '127.0.0.1', '[::1]'), fc.domain()),
  port: fc.integer({ min: 1, max: 65535 }),
  name: fc.constantFrom('little_moments', 'camping'),
  user: fc.constantFrom('app', 'camping'),
  password,
  sslmode: fc.constant('disable'),
});

/** 依 connectWithRetry 的規格計算最多允許的重試次數（累計等待 < totalMs）。 */
function allowedRetries(schedule, totalMs) {
  let sum = 0, n = 0;
  for (const d of schedule) { if (sum + d >= totalMs) break; sum += d; n++; }
  return n;
}

/** 前 failures 次嘗試失敗（錯誤訊息夾帶密碼），之後成功；failures = Infinity 表示永遠失敗。 */
function fakeEnv(db, failures, code) {
  const clock = { t: 1_700_000_000_000 };
  const state = { attempts: 0, sleeps: [], logs: [], closed: 0, createCalls: 0 };
  const sql = () => {
    state.attempts++;
    if (state.attempts <= failures) {
      const err = new Error(`connect failed password=${db.password} postgres://${db.user}:${db.password}@${db.host}`);
      err.code = code;
      return Promise.reject(err);
    }
    return Promise.resolve([{ '?column?': 1 }]);
  };
  const fakeDb = { sql, close: async () => { state.closed++; } };
  return {
    state, fakeDb,
    deps: {
      create: () => { state.createCalls++; return fakeDb; },
      now: () => clock.t,
      sleep: async ms => { state.sleeps.push(ms); clock.t += ms; },
      log: msg => state.logs.push(String(msg)),
      attemptTimeoutMs: 5000,
      totalMs: RETRY_TOTAL_MS,
    },
  };
}

const errorCode = fc.constantFrom('ECONNREFUSED', 'ERR_POSTGRES_CONNECTION_CLOSED', 'ETIMEDOUT', undefined, 'lower-case code');

describe('Property 26: 啟動重連排程', () => {
  test('retrySchedule：每個間隔 1–5 秒、累計 ≤ 30 秒，且剩餘時間不足 1 秒才停止', () => {
    fc.assert(fc.property(randomSeq, seq => {
      const delays = retrySchedule({ random: cycling(seq) });
      expect(delays.length).toBeGreaterThan(0);
      for (const d of delays) {
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(RETRY_MIN_MS);
        expect(d).toBeLessThanOrEqual(RETRY_MAX_MS);
      }
      const sum = delays.reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(RETRY_TOTAL_MS);
      expect(RETRY_TOTAL_MS - sum).toBeLessThan(RETRY_MIN_MS);
    }), RUNS);
  });

  test('connectWithRetry：第一次成功即停止重試並回傳 db；等待總和 < 30 秒且每次 1–5 秒', () => {
    fc.assert(fc.asyncProperty(database, randomSeq, fc.integer({ min: 0, max: 40 }), errorCode,
      async (db, seq, failures, code) => {
        const schedule = retrySchedule({ random: cycling(seq) });
        const { state, fakeDb, deps } = fakeEnv(db, failures, code);
        const retries = allowedRetries(schedule, RETRY_TOTAL_MS);
        const target = `${db.host}:${db.port}`;
        fc.pre(!target.includes(db.password));

        let result, error;
        try { result = await connectWithRetry(db, { ...deps, schedule }); } catch (e) { error = e; }

        // 共同不變量：每次等待 1–5 秒、累計 < 30 秒、嘗試次數 = 等待次數 + 1、只建立一次連線池
        for (const d of state.sleeps) {
          expect(d).toBeGreaterThanOrEqual(RETRY_MIN_MS);
          expect(d).toBeLessThanOrEqual(RETRY_MAX_MS);
        }
        expect(state.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(RETRY_TOTAL_MS);
        expect(state.attempts).toBe(state.sleeps.length + 1);
        expect(state.createCalls).toBe(1);

        // 日誌只含主機與連接埠，不含密碼
        for (const line of state.logs) {
          expect(line).not.toContain(db.password);
          expect(line).toContain(target);
        }

        if (failures <= retries) {
          expect(error).toBeUndefined();
          expect(result).toBe(fakeDb);
          expect(state.attempts).toBe(failures + 1);
          expect(state.closed).toBe(0);
        } else {
          expect(result).toBeUndefined();
          expect(error).toBeInstanceOf(DatabaseConnectError);
          expect(error.message).toContain(target);
          expect(error.message).not.toContain(db.password);
          expect(String(error.code)).not.toContain(db.password);
          expect(state.attempts).toBe(retries + 1);
          expect(state.closed).toBe(1);
        }
      }), RUNS);
  });

  test('connectWithRetry：永遠失敗時拋出 DatabaseConnectError、關閉連線池，且不洩漏密碼', () => {
    fc.assert(fc.asyncProperty(database, randomSeq, errorCode, async (db, seq, code) => {
      const schedule = retrySchedule({ random: cycling(seq) });
      const { state, deps } = fakeEnv(db, Number.POSITIVE_INFINITY, code);
      const target = `${db.host}:${db.port}`;
      fc.pre(!target.includes(db.password));

      let error;
      try { await connectWithRetry(db, { ...deps, schedule }); } catch (e) { error = e; }

      expect(error).toBeInstanceOf(DatabaseConnectError);
      expect(error.message).toBe(`無法連線至 Database ${target}`);
      expect(error.message).not.toContain(db.password);
      expect(error.code).toMatch(/^[A-Z0-9_]{1,64}$/);
      expect(state.closed).toBe(1);
      expect(state.attempts).toBe(allowedRetries(schedule, RETRY_TOTAL_MS) + 1);
      expect(state.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(RETRY_TOTAL_MS);
      for (const line of state.logs) expect(line).not.toContain(db.password);
    }), RUNS);
  });
});
