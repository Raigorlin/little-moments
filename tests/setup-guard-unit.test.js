import { test, expect } from 'bun:test';
import { createSetupGuard, isLoopbackBind } from '../server/setup-guard.js';

const fixedBytes = n => Buffer.alloc(n, 7);

test('loopback bind addresses disable the guard', () => {
  for (const a of ['127.0.0.1', '127.9.8.7', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::1]']) {
    expect(isLoopbackBind(a)).toBe(true);
    const logs = [];
    const g = createSetupGuard({ bindAddress: a, log: m => logs.push(m) });
    expect(g.required).toBe(false);
    expect(g.verify('anything-anything-anything-anything')).toBe(false);
    expect(logs).toEqual([]);
  }
  for (const a of ['0.0.0.0', '192.168.1.10', '::', 'fd00::1', '::ffff:10.0.0.1', 'not-an-ip']) expect(isLoopbackBind(a)).toBe(false);
});

test('generated token is 256-bit base64url, logged exactly once, and verifies', () => {
  const logs = [];
  const g = createSetupGuard({ bindAddress: '0.0.0.0', randomBytes: fixedBytes, log: m => logs.push(m) });
  expect(g.required).toBe(true);
  expect(logs.length).toBe(1);
  const token = Buffer.alloc(32, 7).toString('base64url');
  expect(logs[0]).toContain(token);
  expect(token.length).toBeGreaterThanOrEqual(43);
  expect(g.verify(token)).toBe(true);
  expect(g.verify(token + 'x')).toBe(false);
  expect(g.verify('')).toBe(false);
  expect(g.verify(undefined)).toBe(false);
  expect(logs.length).toBe(1);
});

test('provided token is used without logging; consume invalidates it', () => {
  const logs = [];
  const token = 'a'.repeat(32);
  const g = createSetupGuard({ bindAddress: '192.168.1.5', setupToken: token, log: m => logs.push(m) });
  expect(logs).toEqual([]);
  expect(g.verify(token)).toBe(true);
  expect(g.verify('b'.repeat(32))).toBe(false);
  g.consume();
  expect(g.verify(token)).toBe(false);
});

test('short provided token refuses startup without leaking the value', () => {
  const secret = 'short-secret-value';
  let err;
  try { createSetupGuard({ bindAddress: '0.0.0.0', setupToken: secret, log: () => {} }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe('SETUP_TOKEN_TOO_SHORT');
  expect(err.message).not.toContain(secret);
});
