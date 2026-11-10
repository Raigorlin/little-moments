// Feature: jenkins-cicd-deploy, Property 11: DAST 目標限定
// **Validates: Requirements 7.2, 7.3**
//
// For any ZAP 設定（起始 URL、include 路徑、context URL）與 Target_Allowlist，
// validateDastTargets(config, allowlist) 通過若且唯若 allowlist 非空且每個目標的 origin 都在 allowlist 內；
// 失敗時回報的位址集合恰為不在 allowlist 內的目標。
//
// 預期結果由產生器「依構造」決定（每個目標帶著它的 canonical origin 或「必定拒絕」標記），
// 不呼叫被測模組的正規化函式，避免 oracle 與實作共用錯誤。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { substituteVars, validateDastLimits, validateDastTargets } from '../ci/dast/targets.mjs';

const RUNS = { numRuns: 200 };
const DEFAULT_PORT = { http: '80', https: '443' };
const HOSTS = ['app.test', 'lm-dast-app-1', '10.0.0.5', 'evil.test', 'app.test.evil', 'localhost'];
const SCHEMES = ['http', 'https'];
const PORTS = ['default', '5173', '8080'];

// ---------- origin 宇宙 ----------

const originSpecArb = fc.record({
  scheme: fc.constantFrom(...SCHEMES),
  host: fc.constantFrom(...HOSTS),
  port: fc.constantFrom(...PORTS),
});

const canonical = ({ scheme, host, port }) => `${scheme}://${host}${port === 'default' ? '' : `:${port}`}`;

// 寫法變化：主機與 scheme 大小寫、明確寫出預設連接埠。正規化後應等於 canonical。
const writtenOriginArb = (spec) =>
  fc.record({ upperHost: fc.boolean(), upperScheme: fc.boolean(), explicitDefault: fc.boolean() }).map((v) => {
    const scheme = v.upperScheme ? spec.scheme.toUpperCase() : spec.scheme;
    const host = v.upperHost ? spec.host.toUpperCase() : spec.host;
    const port = spec.port === 'default' ? (v.explicitDefault ? `:${DEFAULT_PORT[spec.scheme]}` : '') : `:${spec.port}`;
    return `${scheme}://${host}${port}`;
  });

const pathArb = fc.constantFrom('', '/', '/login', '/api/trips?x=1', '/a/b#frag');
const escapeRegex = (s) => s.replace(/[.\\[\]{}()*+?|^$]/g, '\\$&');

// ---------- 目標產生器：{ target, kind, origin|null }（origin 為 null 表示必定拒絕） ----------

const goodUrlArb = originSpecArb.chain((spec) =>
  fc.tuple(writtenOriginArb(spec), pathArb).map(([w, p]) => ({ target: w + p, kind: 'url', origin: canonical(spec) })),
);

// 各種偽裝：userinfo、反斜線、未代入變數、非 http(s)、相對路徑 — 無論 allowlist 為何都必須拒絕。
const trickUrlArb = fc
  .tuple(originSpecArb, fc.constantFrom(...HOSTS), fc.constantFrom(0, 1, 2, 3, 4, 5, 6))
  .map(([spec, other, which]) => {
    const o = canonical(spec);
    const targets = [
      `${o}@${other}/`, // userinfo：實際連線到 other
      `${spec.scheme}://user:pw@${spec.host}/`,
      `${spec.scheme}://${other}\\@${spec.host}/`, // 反斜線
      `${spec.scheme}://${spec.host}\\.${other}/`,
      '${DAST_TARGET_ORIGIN}/', // 未代入
      `ftp://${spec.host}/`,
      `ws://${spec.host}/`,
    ];
    return { target: targets[which], kind: 'url', origin: null };
  });

const goodPatternArb = originSpecArb.chain((spec) =>
  fc.tuple(writtenOriginArb(spec), fc.boolean(), fc.constantFrom('/.*', '/api/.*', '/')).map(([w, quoted, tail]) => ({
    target: quoted ? `^\\Q${w}\\E${tail}` : `^${escapeRegex(w)}${tail}`,
    kind: 'pattern',
    origin: canonical(spec),
  })),
);

// 未錨定、交替、origin 後未緊接 `/` 的樣式：必定拒絕。
const trickPatternArb = fc.tuple(originSpecArb, fc.constantFrom(0, 1, 2, 3, 4, 5, 6)).map(([spec, which]) => {
  const o = canonical(spec);
  const targets = [
    `^\\Q${o}\\E.*`, // 可比對 o.evil
    `^\\Q${o}\\E/.*|.*`, // 交替
    `.*`,
    `^${o}.*`, // 主機中的 `.` 未跳脫
    `^\\Q${o}\\E[a-z.]*/.*`,
    `(${escapeRegex(o)})/.*`,
    `^\\Q${o}@evil.test\\E/.*`,
  ];
  return { target: targets[which], kind: 'pattern', origin: null };
});

const urlTargetArb = fc.oneof({ weight: 3, arbitrary: goodUrlArb }, { weight: 1, arbitrary: trickUrlArb });
const patternTargetArb = fc.oneof({ weight: 3, arbitrary: goodPatternArb }, { weight: 1, arbitrary: trickPatternArb });

// ---------- ZAP 計畫產生器 ----------

const contextArb = fc.record({
  urls: fc.array(urlTargetArb, { maxLength: 3 }),
  includePaths: fc.array(patternTargetArb, { maxLength: 3 }),
  // excludePaths 只縮小範圍，任何內容都不視為目標。
  excludePaths: fc.array(fc.constantFrom('.*', '^http://evil.test/.*', 'http://evil.test/'), { maxLength: 2 }),
});

const jobArb = fc.oneof(
  fc.record({ type: fc.constantFrom('spider', 'spiderAjax'), t: urlTargetArb }).map(({ type, t }) => ({
    job: { type, parameters: { context: 'ctx', url: t.target, maxDuration: 5 } },
    targets: [t],
  })),
  // 未知 job 類型，URL 藏在 URL_KEYS 或任意深度的巢狀結構中。
  fc
    .record({ key: fc.constantFrom('endpoint', 'targetUrl', 'apiUrl', 'whatever'), t: urlTargetArb, nested: fc.boolean() })
    .map(({ key, t, nested }) => ({
      job: { type: 'customThing', parameters: nested ? { deep: { list: [{ [key]: t.target }] } } : { [key]: t.target } },
      targets: [t],
    })),
  fc.constant({ job: { type: 'passiveScan-wait', parameters: { maxDuration: 5 } }, targets: [] }),
);

const planArb = fc
  .record({ contexts: fc.array(contextArb, { minLength: 1, maxLength: 3 }), jobs: fc.array(jobArb, { maxLength: 4 }) })
  .map(({ contexts, jobs }) => {
    const targets = [];
    const env = {
      contexts: contexts.map((c, i) => {
        targets.push(...c.urls, ...c.includePaths);
        return { name: `ctx${i}`, urls: c.urls.map((t) => t.target), includePaths: c.includePaths.map((t) => t.target), excludePaths: c.excludePaths };
      }),
      parameters: { failOnError: true },
    };
    for (const j of jobs) targets.push(...j.targets);
    return { config: { env, jobs: jobs.map((j) => j.job) }, targets };
  });

// ---------- allowlist 產生器 ----------

const allowEntryArb = fc.oneof(
  { weight: 4, arbitrary: originSpecArb.chain((spec) =>
    fc.tuple(writtenOriginArb(spec), fc.boolean()).map(([w, slash]) => ({ text: slash ? `${w}/` : w, origin: canonical(spec) }))) },
  // 無效項目：含路徑、query、萬用字元、userinfo、非 http(s)；不得擴大範圍。
  { weight: 1, arbitrary: fc.constantFrom(
    'http://app.test/api', 'http://app.test?x=1', 'http://*.test', 'http://u@app.test', 'ftp://app.test', 'app.test', '',
  ).map((text) => ({ text, origin: null })) },
);

const allowlistArb = fc.tuple(fc.array(allowEntryArb, { maxLength: 4 }), fc.boolean()).map(([entries, asString]) => ({
  value: asString ? entries.map((e) => e.text).join(',') : entries.map((e) => e.text),
  allowed: new Set(entries.filter((e) => e.origin).map((e) => e.origin)),
}));

// ---------- Property 11 ----------

describe('Property 11: DAST 目標限定', () => {
  test('ok 若且唯若 allowlist 非空且所有目標皆在 allowlist；rejected 恰為越界目標', () => {
    fc.assert(
      fc.property(planArb, allowlistArb, ({ config, targets }, { value, allowed }) => {
        const r = validateDastTargets(config, value);
        const expectedRejected = new Set(targets.filter((t) => t.origin === null || !allowed.has(t.origin)).map((t) => t.target));

        expect(new Set(r.rejected)).toEqual(expectedRejected);
        expect(r.rejected.length).toBe(expectedRejected.size); // 去重
        expect(r.errors.includes('empty_allowlist')).toBe(allowed.size === 0);
        expect(r.errors.includes('no_targets')).toBe(targets.length === 0);
        expect(r.ok).toBe(allowed.size > 0 && targets.length > 0 && expectedRejected.size === 0);
        for (const d of r.details) expect(expectedRejected.has(d.target)).toBe(true);
      }),
      RUNS,
    );
  });

  test('所有目標皆由 allowlist 產生時一定通過', () => {
    fc.assert(
      fc.property(planArb, ({ config, targets }) => {
        fc.pre(targets.length > 0 && targets.every((t) => t.origin !== null));
        const r = validateDastTargets(config, [...new Set(targets.map((t) => t.origin))]);
        expect(r.ok).toBe(true);
        expect(r.rejected).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- 範例：特定偽裝與實際範本 ----------

describe('DAST 目標驗證範例', () => {
  const allow = ['http://app.test:5173'];
  const plan = (urls, includePaths = []) => ({ env: { contexts: [{ name: 'c', urls, includePaths }] }, jobs: [] });

  test.each([
    'http://app.test:5174/',
    'https://app.test:5173/',
    'http://app.test.evil:5173/',
    'http://app.test:5173@evil.test/',
    'http://evil.test\\@app.test:5173/',
  ])('拒絕越界 URL %s', (u) => {
    const r = validateDastTargets(plan([u]), allow);
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([u]);
  });

  test('空計畫與空 allowlist 皆失敗', () => {
    expect(validateDastTargets(plan([]), allow).errors).toContain('no_targets');
    expect(validateDastTargets(plan(['http://app.test:5173/']), []).errors).toContain('empty_allowlist');
    expect(validateDastTargets(plan(['http://app.test:5173/']), '').ok).toBe(false);
  });

  const template = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../ci/dast/zap-automation.yaml'), 'utf8'));
  const origin = 'http://lm-dast-app-42:5173';
  const env = { DAST_TARGET_ORIGIN: origin, DAST_REPORT_DIR: '/zap/wrk/reports' };

  test('實際範本代入 origin 後通過，限制亦符合', () => {
    const rendered = substituteVars(template, env);
    const r = validateDastTargets(rendered, [origin]);
    expect(r).toMatchObject({ ok: true, rejected: [], errors: [] });
    expect(validateDastLimits(rendered).ok).toBe(true);
  });

  test('實際範本在空 allowlist、其他 origin 或未代入變數時失敗', () => {
    const rendered = substituteVars(template, env);
    const empty = validateDastTargets(rendered, []);
    expect(empty.ok).toBe(false);
    expect(empty.errors).toContain('empty_allowlist');

    const other = validateDastTargets(rendered, ['http://lm-dast-app-43:5173']);
    expect(other.ok).toBe(false);
    expect(other.rejected.length).toBeGreaterThan(0);

    const unresolved = validateDastTargets(substituteVars(template, {}), [origin]);
    expect(unresolved.ok).toBe(false);
    expect(unresolved.details.some((d) => d.reason === 'unresolved_variable')).toBe(true);
  });
});
