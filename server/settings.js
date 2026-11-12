// Receipt AI and Registration_Policy rules. Pure: no I/O, no database access.

export const RECEIPT_AI_POLICIES = Object.freeze(['all', 'admins', 'off']);
export const RECEIPT_AI_KEY = 'receiptAiPolicy';

export const REGISTRATION_POLICIES = Object.freeze(['open', 'closed']);
export const REGISTRATION_KEY = 'registrationPolicy';

const isPolicy = value => typeof value === 'string' && RECEIPT_AI_POLICIES.includes(value);
const isRegistration = value => typeof value === 'string' && REGISTRATION_POLICIES.includes(value);

// `stored` is the Settings_Store value (null/undefined when no row exists).
// `seed` is the Registration_Seed from CAMPING_REGISTRATION (null when unset).
// A stored value outside the accepted set (manual DB edit) fails closed to `closed` (Req 26.1, 26.2).
export function resolveRegistrationPolicy(stored, seed) {
  if (stored !== null && stored !== undefined) {
    return { value: isRegistration(stored) ? stored : 'closed', source: 'stored' };
  }
  if (isRegistration(seed)) return { value: seed, source: 'seed' };
  return { value: 'open', source: 'default' };
}

// `stored` is the Settings_Store value (null/undefined when no row exists).
// `seed` is the startup seed from the deployment config (null when unset).
// A stored value outside the accepted set (manual DB edit) fails closed to `off`.
export function resolveReceiptAiPolicy(stored, seed) {
  if (stored !== null && stored !== undefined) {
    return { value: isPolicy(stored) ? stored : 'off', source: 'stored' };
  }
  if (isPolicy(seed)) return { value: seed, source: 'seed' };
  return { value: 'all', source: 'default' };
}

// Order matches the existing checks in accounts.js: edit permission first,
// then the policy, then whether a key is configured.
export function receiptAiDecision({ policy, role, canEdit, keyEnabled }) {
  if (!canEdit) return 'no-edit';
  if (policy === 'off' || !isPolicy(policy)) return 'off';
  if (policy === 'admins' && role !== 'admin') return 'admins-only';
  if (!keyEnabled) return 'unconfigured';
  return 'allow';
}
