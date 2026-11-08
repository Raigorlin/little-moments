// Receipt AI cost settings and quota arithmetic (security-hardening Requirement 18).
// Pure module: no file, network, or database access, so tests can import it directly.
import { ConfigError } from './deploy-config.js';

export const AI_ENV = Object.freeze({
  modelId: 'CAMPING_OPENAI_MODEL_ID',
  imageDetail: 'CAMPING_OPENAI_IMAGE_DETAIL',
  maxCompletionTokens: 'CAMPING_OPENAI_MAX_COMPLETION_TOKENS',
  perUser: 'CAMPING_RECEIPT_AI_USER_LIMIT',
  daily: 'CAMPING_RECEIPT_AI_DAILY_LIMIT',
  monthly: 'CAMPING_RECEIPT_AI_MONTHLY_LIMIT'
});

export const AI_COST_DEFAULTS = Object.freeze({
  modelId: 'gpt-6-luna',
  imageDetail: 'high',
  maxCompletionTokens: 6000,
  perUser: 10,
  daily: 100,
  monthly: 1000
});

export const PER_USER_WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MODEL_RE = /^gpt-[A-Za-z0-9._-]{1,80}$/;
const INTEGER_RE = /^[1-9][0-9]*$/;
const IMAGE_DETAILS = ['low', 'high', 'auto'];
const INTEGER_RANGES = Object.freeze({
  maxCompletionTokens: [1, 16000],
  perUser: [1, 100],
  daily: [1, 10000],
  monthly: [1, 100000]
});

const isUnset = value => value === undefined || value === null || value === '';

function parseInteger(env, field) {
  const name = AI_ENV[field];
  const raw = env[name];
  if (isUnset(raw)) return AI_COST_DEFAULTS[field];
  const [min, max] = INTEGER_RANGES[field];
  const text = String(raw);
  const value = INTEGER_RE.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(name, `${name} must be an integer from ${min} to ${max}; got "${raw}".`);
  }
  return value;
}

function parseModelId(env) {
  const name = AI_ENV.modelId;
  const raw = env[name];
  if (isUnset(raw)) return AI_COST_DEFAULTS.modelId;
  if (typeof raw !== 'string' || !MODEL_RE.test(raw)) {
    throw new ConfigError(name, `${name} must be "gpt-" followed by 1 to 80 characters from letters, digits, ".", "_", and "-"; got "${raw}".`);
  }
  return raw;
}

function parseImageDetail(env) {
  const name = AI_ENV.imageDetail;
  const raw = env[name];
  if (isUnset(raw)) return AI_COST_DEFAULTS.imageDetail;
  if (!IMAGE_DETAILS.includes(raw)) {
    throw new ConfigError(name, `${name} must be one of ${IMAGE_DETAILS.join(', ')}; got "${raw}".`);
  }
  return raw;
}

/** Reads and validates AI_Cost_Config. Throws ConfigError naming the bad variable and its allowed range. */
export function parseAiCostConfig(env = {}) {
  const modelId = parseModelId(env);
  const imageDetail = parseImageDetail(env);
  const maxCompletionTokens = parseInteger(env, 'maxCompletionTokens');
  const perUser = parseInteger(env, 'perUser');
  const daily = parseInteger(env, 'daily');
  if (perUser > daily) {
    throw new ConfigError(AI_ENV.daily, `${AI_ENV.daily} must be an integer from ${perUser} (${AI_ENV.perUser}) to ${INTEGER_RANGES.daily[1]}; got "${daily}".`);
  }
  const monthly = parseInteger(env, 'monthly');
  if (daily > monthly) {
    throw new ConfigError(AI_ENV.monthly, `${AI_ENV.monthly} must be an integer from ${daily} (${AI_ENV.daily}) to ${INTEGER_RANGES.monthly[1]}; got "${monthly}".`);
  }
  return Object.freeze({ modelId, imageDetail, maxCompletionTokens, perUser, daily, monthly });
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
