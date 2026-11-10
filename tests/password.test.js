// Feature: jenkins-cicd-deploy, Property 23: 密碼雜湊往返與損壞格式拒絕
// **Validates: Requirements 10.7, 10.8**
import { describe, test, expect, beforeAll } from 'bun:test';
import fc from 'fast-check';
import { hashPassword, verifyPassword } from '../server/accounts.js';

// scrypt(N=16384) costs tens of ms per call, so passwords stay short (12–32 code points,
// matching the 12-character minimum enforced by validatePassword).
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const passwordArb = fc.string({ unit: 'binary', minLength: 12, maxLength: 32 }).filter(s => !LONE_SURROGATE.test(s));
const TIMEOUT = 180_000;

describe('Property 23: 密碼雜湊往返與損壞格式拒絕', () => {
  test('hash → verify round-trips; wrong passwords fail; stored value has the expected shape and no plaintext', async () => {
    await fc.assert(
      fc.asyncProperty(passwordArb, passwordArb, async (p, other) => {
        const q = other === p ? `${p}x` : other;
        const stored = await hashPassword(p);
        const parts = stored.split('$');
        // Req 10.7: algorithm parameters, 16-byte salt and 64-byte hash only.
        expect(parts.length).toBe(6);
        expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
        expect(Buffer.from(parts[4], 'base64').length).toBe(16);
        expect(Buffer.from(parts[5], 'base64').length).toBe(64);
        expect(stored.includes(p)).toBe(false);
        // Req 10.8
        expect(await verifyPassword(p, stored)).toBe(true);
        expect(await verifyPassword(q, stored)).toBe(false);
      }),
      { numRuns: 100 },
    );
  }, TIMEOUT);

  describe('corrupted stored values', () => {
    const password = 'correct horse battery';
    let valid;
    beforeAll(async () => { valid = await hashPassword(password); });

    const nonSafeIntegerArb = fc.oneof(
      fc.constantFrom('abc', '1.5', '16384.5', 'NaN', 'Infinity', '-Infinity', '1e400', '9007199254740993', '0x', '-'),
      fc.double({ noInteger: true, noDefaultInfinity: false }).map(String).filter(s => !Number.isSafeInteger(Number(s))),
      fc.stringMatching(/^[a-z]{1,6}$/),
    );

    // Each corruption produces a value that must verify as false without throwing.
    const corruptionArb = fc.oneof(
      // wrong field count
      fc.integer({ min: 0, max: 5 }).map(n => s => s.split('$').filter((_, i) => i !== n).join('$')),
      fc.stringMatching(/^[A-Za-z0-9+/=]{0,8}$/).map(extra => s => `${s}$${extra}`),
      // wrong algorithm prefix
      fc.constantFrom('', 'bcrypt', 'SCRYPT', 'argon2', 'scrypt ').map(prefix => s => [prefix, ...s.split('$').slice(1)].join('$')),
      // non-safe-integer N / r / p
      fc.tuple(fc.integer({ min: 1, max: 3 }), nonSafeIntegerArb).map(([i, v]) => s => { const a = s.split('$'); a[i] = v; return a.join('$'); }),
      // hash field empty or not decodable base64 (decodes to zero bytes)
      fc.constantFrom('', '!!!!', '$', '@@', '*').map(v => s => { const a = s.split('$'); a[5] = v; return a.slice(0, 6).join('$'); }),
      // tampered hash bytes
      fc.tuple(fc.integer({ min: 0, max: 63 }), fc.integer({ min: 1, max: 255 })).map(([i, x]) => s => {
        const a = s.split('$'); const h = Buffer.from(a[5], 'base64'); h[i] ^= x; a[5] = h.toString('base64'); return a.join('$');
      }),
      // tampered salt
      fc.tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 1, max: 255 })).map(([i, x]) => s => {
        const a = s.split('$'); const b = Buffer.from(a[4], 'base64'); b[i] ^= x; a[4] = b.toString('base64'); return a.join('$');
      }),
      // arbitrary garbage
      fc.string({ maxLength: 40 }).filter(g => g.split('$').length !== 6).map(g => () => g),
    );

    test('every corrupted format verifies as false and never throws', async () => {
      await fc.assert(
        fc.asyncProperty(corruptionArb, async corrupt => {
          const stored = corrupt(valid);
          fc.pre(stored !== valid);
          await expect(verifyPassword(password, stored)).resolves.toBe(false);
        }),
        { numRuns: 100 },
      );
    }, TIMEOUT);

    test('non-string stored values verify as false', async () => {
      for (const stored of [undefined, null, 0, {}, []]) {
        expect(await verifyPassword(password, stored)).toBe(false);
      }
      expect(await verifyPassword(password, valid)).toBe(true);
    });
  });
});
