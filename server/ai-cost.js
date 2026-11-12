// Receipt AI cost settings and quota arithmetic (security-hardening Requirement 18).
// Pure module: no file, network, or database access, so tests can import it directly.
// The variable names, defaults, and validation live in server/config.js, so parseConfig
// refuses startup on the same values; this module keeps the throwing parser and the quota math.
import { AI_COST_DEFAULTS, AI_ENV, ConfigError, parseAiCostSettings } from './config.js';

export { AI_COST_DEFAULTS, AI_ENV };

export const PER_USER_WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads and validates AI_Cost_Config. Throws a ConfigError (server/config.js) for the first invalid
 * variable; the error names the variable and its allowed range, never the value.
 */
export function parseAiCostConfig(env = {}) {
  const { aiCost, errors } = parseAiCostSettings(env);
  if (errors.length) throw new ConfigError(errors[0].name, errors[0].reason);
  return aiCost;
}

export function utcDayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function nextUtcDayStart(ms) {
  return utcDayStart(ms) + DAY_MS;
}

export function utcMonthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextUtcMonthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const toSeconds = ms => Math.max(1, Math.ceil(ms / 1000));

/**
 * Decides whether one more receipt AI call fits the per-user, UTC day, and UTC month limits.
 * `userTimes` holds the user's call times within the last 15 minutes, sorted ascending.
 * Returns { ok: true } or { ok: false, retryAfter } with whole seconds (at least 1) until all limits fit.
 */
export function quotaDecision({ now, userTimes = [], dayCount = 0, monthCount = 0, config = AI_COST_DEFAULTS }) {
  const waits = [];
  if (userTimes.length >= config.perUser) {
    waits.push(userTimes[userTimes.length - config.perUser] + PER_USER_WINDOW_MS - now);
  }
  if (dayCount >= config.daily) waits.push(nextUtcDayStart(now) - now);
  if (monthCount >= config.monthly) waits.push(nextUtcMonthStart(now) - now);
  if (!waits.length) return { ok: true };
  return { ok: false, retryAfter: toSeconds(Math.max(...waits)) };
}

/**
 * Maximum cost estimate in the price currency. `pricePerMillion` holds input and output prices per
 * one million tokens; `imageInputTokens` is the input token count assumed for one request.
 */
export function costEstimate({ config = AI_COST_DEFAULTS, pricePerMillion, imageInputTokens }) {
  const perRequest = (imageInputTokens * pricePerMillion.input + config.maxCompletionTokens * pricePerMillion.output) / 1_000_000;
  return { perRequest, perDay: perRequest * config.daily, perMonth: perRequest * config.monthly };
}
