import { test, expect } from 'bun:test';
import fc from 'fast-check';
import {
  RECEIPT_AI_POLICIES, RECEIPT_AI_KEY, REGISTRATION_POLICIES, REGISTRATION_KEY,
  resolveReceiptAiPolicy, resolveRegistrationPolicy, receiptAiDecision
} from '../server/settings.js';
import { REGISTRATION_POLICIES as CONFIG_REGISTRATION_POLICIES, DEFAULT_REGISTRATION_POLICY } from '../server/config.js';

test('policy constants', () => {
  expect([...RECEIPT_AI_POLICIES]).toEqual(['all', 'admins', 'off']);
  expect(RECEIPT_AI_KEY).toBe('receiptAiPolicy');
  expect([...REGISTRATION_POLICIES]).toEqual(['open', 'closed']);
  expect(Object.isFrozen(REGISTRATION_POLICIES)).toBe(true);
  expect(REGISTRATION_KEY).toBe('registrationPolicy');
  // server/config.js re-exports the same list, so existing imports keep working.
  expect(CONFIG_REGISTRATION_POLICIES).toBe(REGISTRATION_POLICIES);
  expect(DEFAULT_REGISTRATION_POLICY).toBe(resolveRegistrationPolicy(null, null).value);
});

// Requirements 26.1, 26.2: exhaustive stored × seed table for the Registration_Policy.
test('resolveRegistrationPolicy: exhaustive stored × seed table', () => {
  const absent = [null, undefined];
  const valid = ['open', 'closed'];
  const invalidStored = ['', 'Open', 'CLOSED', ' closed', 'closed ', 'invite', 0, true, ['open']];
  const seeds = [null, 'open', 'closed'];
  const expected = (stored, seed) => {
    if (absent.includes(stored)) return valid.includes(seed) ? { value: seed, source: 'seed' } : { value: 'open', source: 'default' };
    if (valid.includes(stored)) return { value: stored, source: 'stored' };
    return { value: 'closed', source: 'stored' }; // fail closed
  };
  let rows = 0;
  for (const stored of [...absent, ...valid, ...invalidStored]) {
    for (const seed of seeds) {
      expect({ stored, seed, result: resolveRegistrationPolicy(stored, seed) })
        .toEqual({ stored, seed, result: expected(stored, seed) });
      rows++;
    }
  }
  expect(rows).toBe(39);
  expect(resolveRegistrationPolicy(null, null)).toEqual({ value: 'open', source: 'default' });
  expect(resolveRegistrationPolicy(null, 'closed')).toEqual({ value: 'closed', source: 'seed' });
  expect(resolveRegistrationPolicy('open', 'closed')).toEqual({ value: 'open', source: 'stored' });
  expect(resolveRegistrationPolicy('Open', 'open')).toEqual({ value: 'closed', source: 'stored' });
});

// Feature: jenkins-cicd-deploy, Property 48: Registration_Policy 決定順序
// **Validates: Requirements 26.1, 26.2**
test('Property 48: Registration_Policy 決定順序', () => {
  // Stored values: absent, exact policies, case and whitespace variants, arbitrary strings, and non-strings.
  const variant = fc.constantFrom('open', 'closed').chain(p => fc.constantFrom(
    p.toUpperCase(), p[0].toUpperCase() + p.slice(1), ` ${p}`, `${p} `, `\t${p}`, `${p}\n`, `${p}d`
  ));
  const storedArb = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(null, undefined) },
    { weight: 3, arbitrary: fc.constantFrom('open', 'closed') },
    { weight: 3, arbitrary: variant },
    { weight: 2, arbitrary: fc.string({ maxLength: 12 }) },
    { weight: 2, arbitrary: fc.oneof(fc.integer(), fc.double(), fc.boolean(), fc.array(fc.constantFrom('open', 'closed'), { maxLength: 2 }), fc.constant({})) }
  );
  const seedArb = fc.constantFrom(null, 'open', 'closed');
  // Decision table as the reference implementation.
  const reference = (stored, seed) => {
    if (stored === null || stored === undefined) return seed === 'open' || seed === 'closed' ? { value: seed, source: 'seed' } : { value: 'open', source: 'default' };
    return { value: stored === 'open' || stored === 'closed' ? stored : 'closed', source: 'stored' };
  };
  fc.assert(fc.property(storedArb, seedArb, (stored, seed) => {
    const got = resolveRegistrationPolicy(stored, seed);
    expect(['open', 'closed']).toContain(got.value);
    expect(got).toEqual(reference(stored, seed));
    // A stored value decides alone: the seed does not matter.
    if (stored !== null && stored !== undefined) {
      for (const other of [null, 'open', 'closed']) expect(resolveRegistrationPolicy(stored, other)).toEqual(got);
    }
  }), { numRuns: 100 });
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
