// Receipt AI policy rules. Pure: no I/O, no database access.

export const RECEIPT_AI_POLICIES = Object.freeze(['all', 'admins', 'off']);
export const RECEIPT_AI_KEY = 'receiptAiPolicy';

const isPolicy = value => typeof value === 'string' && RECEIPT_AI_POLICIES.includes(value);

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
