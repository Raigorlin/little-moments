import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { RECEIPT_AI_POLICIES, RECEIPT_AI_KEY, resolveReceiptAiPolicy, receiptAiDecision } from '../server/settings.js';

test('policy constants', () => {
  expect([...RECEIPT_AI_POLICIES]).toEqual(['all', 'admins', 'off']);
  expect(RECEIPT_AI_KEY).toBe('receiptAiPolicy');
});

// Requirements 11.5-11.7: exhaustive stored × seed table.
// Stored values: absent (null/undefined), each valid policy, and invalid manual edits.
// Seeds: unset, each valid policy, and an invalid value (config validation normally rejects it).
test('resolveReceiptAiPolicy: exhaustive stored × seed table', () => {
  const absent = [null, undefined];
  const valid = ['all', 'admins', 'off'];
  const invalidStored = ['', 'ALL', 'none', 'admin', ' off'];
  const seeds = [null, undefined, 'all', 'admins', 'off', 'bogus'];
  const expected = (stored, seed) => {
    if (absent.includes(stored)) {
      if (valid.includes(seed)) return { value: seed, source: 'seed' };
      return { value: 'all', source: 'default' };
    }
    if (valid.includes(stored)) return { value: stored, source: 'stored' };
    return { value: 'off', source: 'stored' }; // fail closed
  };
  let rows = 0;
  for (const stored of [...absent, ...valid, ...invalidStored]) {
    for (const seed of seeds) {
      expect({ stored, seed, result: resolveReceiptAiPolicy(stored, seed) })
        .toEqual({ stored, seed, result: expected(stored, seed) });
      rows++;
    }
  }
  expect(rows).toBe(60);
  // Spot checks from the requirements.
  expect(resolveReceiptAiPolicy(null, null)).toEqual({ value: 'all', source: 'default' });
  expect(resolveReceiptAiPolicy(null, 'admins')).toEqual({ value: 'admins', source: 'seed' });
  expect(resolveReceiptAiPolicy('off', 'all')).toEqual({ value: 'off', source: 'stored' });
  expect(resolveReceiptAiPolicy('garbage', 'all')).toEqual({ value: 'off', source: 'stored' });
});

// Feature: publish-behind-nginx, Property 10: Receipt AI decision follows the policy table
// **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
test('Property 10: Receipt AI decision follows the policy table', () => {
  // Independent model: a full lookup table keyed by policy, role, canEdit, keyEnabled.
  const TABLE = {
    all:    { admin: { key: 'allow', nokey: 'unconfigured' },  member: { key: 'allow', nokey: 'unconfigured' } },
    admins: { admin: { key: 'allow', nokey: 'unconfigured' },  member: { key: 'admins-only', nokey: 'admins-only' } },
    off:    { admin: { key: 'off', nokey: 'off' },             member: { key: 'off', nokey: 'off' } },
  };
  const model = ({ policy, role, canEdit, keyEnabled }) =>
    canEdit ? TABLE[policy][role][keyEnabled ? 'key' : 'nokey'] : 'no-edit';
  // Status route mapping described in the design, applied to the decision.
  const status = decision => ({
    enabled: decision === 'allow',
    policyDisabled: decision === 'off' || decision === 'admins-only',
  });

  fc.assert(
    fc.property(
      fc.constantFrom('all', 'admins', 'off'),
      fc.constantFrom('admin', 'member'),
      fc.boolean(),
      fc.boolean(),
      (policy, role, canEdit, keyEnabled) => {
        const input = { policy, role, canEdit, keyEnabled };
        const got = receiptAiDecision(input);
        const want = model(input);
        expect(got).toBe(want);
        expect(status(got)).toEqual(status(want));
      },
    ),
    { numRuns: 200 },
  );
});
