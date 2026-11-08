import { test, expect, describe } from 'bun:test';
import fc from 'fast-check';
import { ConfigError } from '../server/deploy-config.js';
import {
  AI_ENV,
  AI_COST_DEFAULTS,
  PER_USER_WINDOW_MS,
  parseAiCostConfig,
  utcDayStart,
  utcMonthStart,
  nextUtcDayStart,
  nextUtcMonthStart,
  quotaDecision,
  costEstimate
} from '../server/ai-cost.js';

const DAY = 24 * 60 * 60 * 1000;
const at = iso => Date.parse(iso);

const RANGES = { maxCompletionTokens: [1, 16000], perUser: [1, 100], daily: [1, 10000], monthly: [1, 100000] };

function catchConfigError(env) {
  try { parseAiCostConfig(env); } catch (error) { return error; }
  return null;
}

// A valid AI_Cost_Config, as the config object it should parse to.
const validConfig = fc.integer({ min: 1, max: 100 }).chain(perUser =>
  fc.integer({ min: perUser, max: 10000 }).chain(daily =>
    fc.record({
      modelId: fc.stringMatching(/^gpt-[A-Za-z0-9._-]{1,80}$/),
      imageDetail: fc.constantFrom('low', 'high', 'auto'),
      maxCompletionTokens: fc.integer({ min: 1, max: 16000 }),
      perUser: fc.constant(perUser),
      daily: fc.constant(daily),
      monthly: fc.integer({ min: daily, max: 100000 })
    })));

const toEnv = config => Object.fromEntries(Object.entries(config).map(([field, value]) => [AI_ENV[field], String(value)]));

const badInteger = field => {
  const [min, max] = RANGES[field];
  return fc.oneof(
    fc.constantFrom('0', '-1', '1.5', '01', ' 5', '5 ', 'abc', '1e3', '0x10', 'NaN', '+5', String(max + 1), '99999999999999999999'),
    fc.integer({ min: max + 1, max: max * 100 }).map(String),
    fc.integer({ min: -1000, max: min - 1 }).map(String)
  );
};

const badModel = fc.oneof(
  fc.constantFrom('gpt-', 'GPT-4o', 'gpt 4', 'gpt-4 o', 'claude-3', 'gpt-4/turbo', ' gpt-4', 'gpt-' + 'a'.repeat(81)),
  fc.stringMatching(/^[a-z]{1,10}$/).filter(s => !s.startsWith('gpt-'))
);

const badDetail = fc.oneof(
  fc.constantFrom('HIGH', 'Low', 'medium', ' low', 'auto ', 'none'),
  fc.string({ minLength: 1, maxLength: 10 }).filter(s => !['low', 'high', 'auto'].includes(s))
);

// One environment with exactly one invalid setting, plus the variable the error must name.
const invalidCase = validConfig.chain(config => fc.oneof(
  badModel.map(raw => ({ config, field: 'modelId', raw })),
  badDetail.map(raw => ({ config, field: 'imageDetail', raw })),
  badInteger('maxCompletionTokens').map(raw => ({ config, field: 'maxCompletionTokens', raw })),
  badInteger('perUser').map(raw => ({ config, field: 'perUser', raw })),
  badInteger('daily').map(raw => ({ config, field: 'daily', raw })),
  badInteger('monthly').map(raw => ({ config, field: 'monthly', raw })),
  // Ordering violations: each value is in range on its own, the later one in the order is named.
  fc.integer({ min: 1, max: 99 }).chain(daily => fc.integer({ min: daily + 1, max: 100 })
    .map(perUser => ({ config: { ...config, perUser, daily, monthly: Math.max(config.monthly, daily) }, field: 'daily', raw: String(daily), order: true }))),
  fc.integer({ min: 1, max: 9999 }).chain(monthly => fc.integer({ min: monthly + 1, max: 10000 })
    .map(daily => ({ config: { ...config, perUser: Math.min(config.perUser, daily), daily, monthly }, field: 'monthly', raw: String(monthly), order: true })))
));

describe('parseAiCostConfig', () => {
  // Feature: security-hardening, Property 22: Invalid AI settings stop startup with a named error
  test('Property 22: one invalid setting throws a ConfigError naming it; valid settings round-trip', () => {
    fc.assert(fc.property(invalidCase, ({ config, field, raw, order }) => {
      const env = toEnv(config);
      if (!order) env[AI_ENV[field]] = raw;
      const error = catchConfigError(env);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.setting).toBe(AI_ENV[field]);
      expect(error.message).toContain(AI_ENV[field]);
      if (field === 'modelId') expect(error.message).toContain('"gpt-" followed by 1 to 80 characters');
      else if (field === 'imageDetail') expect(error.message).toContain('low, high, auto');
      else if (order) expect(error.message).toMatch(/must be an integer from \d+ \(CAMPING_RECEIPT_AI_\w+\) to \d+/);
      else expect(error.message).toContain(`from ${RANGES[field][0]} to ${RANGES[field][1]}`);
    }), { numRuns: 300 });

    fc.assert(fc.property(validConfig, fc.subarray(Object.keys(AI_ENV)), (config, unset) => {
      const env = toEnv(config);
      for (const field of unset) env[AI_ENV[field]] = '';
      const expected = { ...config };
      for (const field of unset) expected[field] = AI_COST_DEFAULTS[field];
      // Clearing a value can break the order (e.g. monthly default 1000 < daily); skip those combinations.
      fc.pre(expected.perUser <= expected.daily && expected.daily <= expected.monthly);
      const parsed = parseAiCostConfig(env);
      expect(parsed).toEqual(expected);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(parsed.perUser <= parsed.daily && parsed.daily <= parsed.monthly).toBe(true);
      expect(parseAiCostConfig(toEnv(parsed))).toEqual(parsed);
    }), { numRuns: 200 });
  });

  test('empty environment gives the Requirement 18.1 defaults', () => {
    const expected = { modelId: 'gpt-6-luna', imageDetail: 'high', maxCompletionTokens: 6000, perUser: 10, daily: 100, monthly: 1000 };
    expect(parseAiCostConfig({})).toEqual(expected);
    expect(parseAiCostConfig()).toEqual(expected);
    expect(parseAiCostConfig(Object.fromEntries(Object.values(AI_ENV).map(name => [name, ''])))).toEqual(expected);
    expect(AI_COST_DEFAULTS).toEqual(expected);
    expect(Object.isFrozen(parseAiCostConfig({}))).toBe(true);
  });

  test('variable names keep the existing model variable and the CAMPING_ prefix', () => {
    expect(AI_ENV.modelId).toBe('CAMPING_OPENAI_MODEL_ID');
    for (const name of Object.values(AI_ENV)) expect(name.startsWith('CAMPING_')).toBe(true);
  });

  test('range boundaries are inclusive', () => {
    const env = {
      [AI_ENV.maxCompletionTokens]: '16000', [AI_ENV.perUser]: '100',
      [AI_ENV.daily]: '10000', [AI_ENV.monthly]: '100000'
    };
    expect(parseAiCostConfig(env)).toMatchObject({ maxCompletionTokens: 16000, perUser: 100, daily: 10000, monthly: 100000 });
    expect(parseAiCostConfig({ [AI_ENV.maxCompletionTokens]: '1', [AI_ENV.perUser]: '1', [AI_ENV.daily]: '1', [AI_ENV.monthly]: '1' }))
      .toMatchObject({ maxCompletionTokens: 1, perUser: 1, daily: 1, monthly: 1 });
    expect(parseAiCostConfig({ [AI_ENV.modelId]: 'gpt-' + 'a'.repeat(80) }).modelId).toHaveLength(84);
    expect(catchConfigError({ [AI_ENV.maxCompletionTokens]: '16001' })?.setting).toBe(AI_ENV.maxCompletionTokens);
  });
});

describe('UTC period helpers', () => {
  test('day start and next day start', () => {
    const now = at('2024-03-15T13:45:12.345Z');
    expect(utcDayStart(now)).toBe(at('2024-03-15T00:00:00.000Z'));
    expect(nextUtcDayStart(now)).toBe(at('2024-03-16T00:00:00.000Z'));
    const midnight = at('2024-03-16T00:00:00.000Z');
    expect(utcDayStart(midnight)).toBe(midnight);
    expect(nextUtcDayStart(midnight)).toBe(midnight + DAY);
    expect(utcDayStart(midnight - 1)).toBe(at('2024-03-15T00:00:00.000Z'));
  });

  test('31-day month ends at the next month start', () => {
    const last = at('2024-01-31T23:59:59.999Z');
    expect(utcMonthStart(last)).toBe(at('2024-01-01T00:00:00.000Z'));
    expect(nextUtcMonthStart(last)).toBe(at('2024-02-01T00:00:00.000Z'));
    expect(nextUtcMonthStart(last) - utcMonthStart(last)).toBe(31 * DAY);
  });

  test('February in leap and non-leap years', () => {
    expect(nextUtcMonthStart(at('2024-02-29T12:00:00Z')) - utcMonthStart(at('2024-02-29T12:00:00Z'))).toBe(29 * DAY);
    expect(nextUtcMonthStart(at('2023-02-10T00:00:00Z'))).toBe(at('2023-03-01T00:00:00Z'));
    expect(nextUtcMonthStart(at('2023-02-10T00:00:00Z')) - utcMonthStart(at('2023-02-10T00:00:00Z'))).toBe(28 * DAY);
  });

  test('month start at the boundary and December rollover', () => {
    const start = at('2024-03-01T00:00:00.000Z');
    expect(utcMonthStart(start)).toBe(start);
    expect(utcMonthStart(start - 1)).toBe(at('2024-02-01T00:00:00.000Z'));
    expect(nextUtcMonthStart(at('2024-12-31T23:00:00Z'))).toBe(at('2025-01-01T00:00:00Z'));
  });
});

describe('quotaDecision', () => {
  const config = parseAiCostConfig({ [AI_ENV.perUser]: '3', [AI_ENV.daily]: '5', [AI_ENV.monthly]: '8' });
  const now = at('2024-03-15T12:00:00.000Z');

  test('fits when every count is below its limit', () => {
    expect(quotaDecision({ now, userTimes: [now - 1000, now - 500], dayCount: 4, monthCount: 7, config })).toEqual({ ok: true });
    expect(quotaDecision({ now, config })).toEqual({ ok: true });
  });

  test('per-user limit waits until the oldest counted call leaves the 15-minute window', () => {
    const userTimes = [now - 600_000, now - 300_000, now - 60_000];
    expect(quotaDecision({ now, userTimes, dayCount: 3, monthCount: 3, config }))
      .toEqual({ ok: false, retryAfter: (PER_USER_WINDOW_MS - 600_000) / 1000 });
    // Four calls with a limit of three: the second oldest must leave before a new call fits.
    const four = [now - 800_000, now - 700_000, now - 100_000, now - 50_000];
    expect(quotaDecision({ now, userTimes: four, config }).retryAfter).toBe((PER_USER_WINDOW_MS - 700_000) / 1000);
  });

  test('day limit waits until the next UTC midnight', () => {
    expect(quotaDecision({ now, dayCount: 5, monthCount: 5, config })).toEqual({ ok: false, retryAfter: 12 * 60 * 60 });
  });

  test('month limit waits until the next UTC month start', () => {
    const result = quotaDecision({ now, dayCount: 2, monthCount: 8, config });
    expect(result).toEqual({ ok: false, retryAfter: (at('2024-04-01T00:00:00Z') - now) / 1000 });
  });

  test('several exceeded limits use the longest wait', () => {
    const userTimes = [now - 100_000, now - 90_000, now - 80_000];
    expect(quotaDecision({ now, userTimes, dayCount: 5, monthCount: 2, config }).retryAfter).toBe(12 * 60 * 60);
    expect(quotaDecision({ now, userTimes, dayCount: 5, monthCount: 8, config }).retryAfter).toBe((at('2024-04-01T00:00:00Z') - now) / 1000);
  });

  test('waits round up to whole seconds and are at least 1', () => {
    const late = at('2024-03-15T23:59:59.999Z');
    expect(quotaDecision({ now: late, dayCount: 5, config }).retryAfter).toBe(1);
    const userTimes = [now - PER_USER_WINDOW_MS + 1500, now - 10, now - 5];
    expect(quotaDecision({ now, userTimes, config }).retryAfter).toBe(2);
    expect(quotaDecision({ now, userTimes: [now - PER_USER_WINDOW_MS, now, now], config }).retryAfter).toBe(1);
  });
});

describe('costEstimate', () => {
  test('per request, day, and month from the configured limits', () => {
    const result = costEstimate({ config: AI_COST_DEFAULTS, pricePerMillion: { input: 1.25, output: 10 }, imageInputTokens: 1000 });
    expect(result.perRequest).toBeCloseTo(0.06125, 10);
    expect(result.perDay).toBeCloseTo(6.125, 10);
    expect(result.perMonth).toBeCloseTo(61.25, 10);
  });

  test('uses maxCompletionTokens, daily, and monthly from the given config', () => {
    const config = parseAiCostConfig({ [AI_ENV.maxCompletionTokens]: '2000', [AI_ENV.daily]: '50', [AI_ENV.monthly]: '500' });
    const result = costEstimate({ config, pricePerMillion: { input: 2, output: 8 }, imageInputTokens: 500 });
    expect(result.perRequest).toBeCloseTo((500 * 2 + 2000 * 8) / 1_000_000, 12);
    expect(result.perDay).toBeCloseTo(result.perRequest * 50, 12);
    expect(result.perMonth).toBeCloseTo(result.perRequest * 500, 12);
  });
});
