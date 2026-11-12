// Feature: jenkins-cicd-deploy, Property 43: Digest 查詢只回傳相符紀錄
// **Validates: Requirements 21.7, 21.8**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { afterAll, beforeAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { lookupByDigest, auditSummary, finalizeRecord, NOT_APPLICABLE, NOT_RUN, TRIGGER_KINDS } from '../ci/record.mjs';
import {
  fingerprintId, parseJenkinsBase, jobPath, buildRefsFromFingerprint, lookupDigest, main as lookupMain,
  LookupError, EXIT, NOT_FOUND_REASON, TRUSTED_JOB_PREFIX,
} from '../ci/digest-lookup.mjs';

const RUNS = { numRuns: 200 };
const HEX = '0123456789abcdef'.split('');

// 64 字元小寫 hex；首字固定為字母，確保大寫變體與原值不同。
const hex64 = fc
  .tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), fc.array(fc.constantFrom(...HEX), { minLength: 63, maxLength: 63 }))
  .map(([h, t]) => h + t.join(''));
const validDigest = hex64.map((h) => `sha256:${h}`);

// 與合法 digest 極相近但不相等（或格式無效）的變體。
const NEAR_MISS = [
  (d) => d.toUpperCase(),
  (d) => `sha256:${d.slice(7).toUpperCase()}`,
  (d) => d.slice(7),
  (d) => d.slice(0, -1),
  (d) => `${d}0`,
  (d) => ` ${d}`,
  (d) => `${d}\n`,
  (d) => `SHA256:${d.slice(7)}`,
  (d) => d.slice(0, 7 + 32),
  (d) => d.replace('sha256:', 'sha512:'),
];
const isValidFormat = (s) => /^sha256:[0-9a-f]{64}$/.test(s);

const commitArb = fc.array(fc.constantFrom(...HEX), { minLength: 40, maxLength: 40 }).map((a) => a.join(''));

// 建立一組 digest 池，紀錄從池中挑選（允許多筆共用同一 digest），部分紀錄使用近似變體或缺少 image。
const scenarioArb = fc
  .uniqueArray(validDigest, { minLength: 1, maxLength: 5 })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      absent: validDigest.filter((d) => !pool.includes(d)),
      records: fc.array(
        fc.oneof(
          { weight: 5, arbitrary: fc.constantFrom(...pool).map((digest) => ({ digest })) },
          {
            weight: 3,
            arbitrary: fc
              .tuple(fc.constantFrom(...pool), fc.integer({ min: 0, max: NEAR_MISS.length - 1 }))
              .map(([d, i]) => ({ digest: NEAR_MISS[i](d) })),
          },
          { weight: 1, arbitrary: fc.constant({ digest: undefined }) },
        ).chain(({ digest }) =>
          fc.record({ id: fc.nat(), commit: commitArb }).map(({ id, commit }) => ({
            build: { job: 'release/little-moments/main', number: id + 1 },
            source: { commit, trigger: 'main_push', ref: 'main' },
            ...(digest === undefined ? {} : { image: { digest } }),
          })),
        ),
        { maxLength: 20 },
      ),
      pick: fc.integer({ min: 0, max: pool.length - 1 }),
      miss: fc.integer({ min: 0, max: NEAR_MISS.length - 1 }),
    }),
  );

describe('Property 43: Digest 查詢只回傳相符紀錄', () => {
  test('既有 digest：回傳恰為 image.digest 完全相等的紀錄，順序保留', () => {
    fc.assert(
      fc.property(scenarioArb, ({ pool, records, pick }) => {
        const q = pool[pick];
        const expected = records.filter((r) => r.image?.digest === q);
        const res = lookupByDigest(records, q);
        if (expected.length === 0) {
          expect(res).toEqual({ found: false, records: [], reason: '查無對應紀錄' });
        } else {
          expect(res.found).toBe(true);
          expect(res.records.length).toBe(expected.length);
          res.records.forEach((r, i) => {
            expect(r).toBe(expected[i]);
            expect(r.image.digest).toBe(q);
          });
        }
      }),
      RUNS,
    );
  });

  test('近似變體：格式無效者拒絕；格式有效但不同者不會比對到原 digest', () => {
    fc.assert(
      fc.property(scenarioArb, ({ pool, records, pick, miss }) => {
        const q = NEAR_MISS[miss](pool[pick]);
        const res = lookupByDigest(records, q);
        if (!isValidFormat(q)) {
          expect(res).toEqual({ found: false, records: [], reason: 'Image_Digest 格式無效' });
          return;
        }
        // 例如截斷到前綴的值不可能是 64 hex；任何有效變體只能比對到逐字元相等者。
        for (const r of res.records) expect(r.image.digest).toBe(q);
        expect(res.records.length).toBe(records.filter((r) => r.image?.digest === q).length);
      }),
      RUNS,
    );
  });

  test('查無的合法 digest：found false、records []、明確原因', () => {
    fc.assert(
      fc.property(scenarioArb, ({ records, absent }) => {
        expect(lookupByDigest(records, absent)).toEqual({ found: false, records: [], reason: '查無對應紀錄' });
      }),
      RUNS,
    );
  });

  test('非字串或非陣列輸入不拋例外', () => {
    fc.assert(
      fc.property(fc.anything(), validDigest, (junk, d) => {
        const res = lookupByDigest(junk, d);
        expect(res.found).toBe(false);
        expect(res.records).toEqual([]);
        if (typeof junk !== 'string') expect(lookupByDigest([], junk).reason).toBe('Image_Digest 格式無效');
      }),
      RUNS,
    );
  });

  test('auditSummary 顯示 commit、Release_Tag、核准人、核准時間與最後一次 Production 部署時間', () => {
    const iso = fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }).map((d) => d.toISOString());
    const deployArb = fc.record({ env: fc.constantFrom('staging', 'production'), at: iso, digest: validDigest, result: fc.constant('ok') });
    fc.assert(
      fc.property(
        validDigest,
        commitArb,
        fc.constantFrom(...TRIGGER_KINDS),
        fc.constantFrom('main', 'v1.2.3', 'PR-12', 'feature/x'),
        fc.option(fc.record({ approver: fc.constantFrom('alice', 'bob'), at: iso }), { nil: undefined }),
        fc.array(deployArb, { maxLength: 6 }),
        (digest, commit, trigger, ref, approval, deployments) => {
          const record = {
            build: { job: 'release/little-moments/x', number: 7 },
            source: { commit, trigger, ref },
            image: { digest },
            ...(approval ? { approval } : {}),
            deployments,
          };
          const s = auditSummary(record);
          expect(s.digest).toBe(digest);
          expect(s.commit).toBe(commit);
          expect(s.releaseTag).toBe(trigger === 'release_tag' ? ref : NOT_APPLICABLE);
          const placeholder = trigger === 'release_tag' ? NOT_RUN : NOT_APPLICABLE;
          expect(s.approver).toBe(approval ? approval.approver : placeholder);
          expect(s.approvedAt).toBe(approval ? approval.at : placeholder);
          const prod = deployments.filter((d) => d.env === 'production');
          expect(s.productionDeployedAt).toBe(prod.length ? prod[prod.length - 1].at : NOT_APPLICABLE);
          expect(s.build).toBe('release/little-moments/x#7');
          // 不改變輸入紀錄。
          expect(record.source.commit).toBe(commit);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------- ci/digest-lookup.mjs（Task 14.7）
// 以只綁定 127.0.0.1 的本機 stub server 模擬 Jenkins fingerprint API 與 artifact 下載。

const TOKEN = 'stub-api-token-0123456789abcdef';
const USER = 'auditor-bot';
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const D = (c) => `sha256:${c.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

function makeRecord({ job, number, digest, trigger = 'main_push', ref = 'main', approval, deployments = [] }) {
  return finalizeRecord({
    schema: 1,
    build: { job, number, url: `https://jenkins.invalid/${number}/`, startedAt: '2025-01-01T00:00:00.000Z' },
    source: { commit: COMMIT, trigger, ref },
    toolchain: { buildImageDigest: D('9') },
    image: { digest },
    ...(approval ? { approval } : {}),
    deployments,
    gates: [],
  }, { status: 'SUCCESS' });
}

/** Jenkins stub：state.fingerprints[md5] → JSON 或 HTTP 狀態碼；state.artifacts[path] → 紀錄。 */
const state = { fingerprints: {}, artifacts: {}, requests: [], delayMs: 0, redirectHit: false };
let server;
let base;

function jenkinsPathOf(job, number) {
  return `/${job.split('/').map((s) => `job/${encodeURIComponent(s)}/`).join('')}${number}/artifact/reports/build-record.json`;
}

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      state.requests.push({ url: req.url, auth: req.headers.get('authorization') });
      if (state.delayMs) await Bun.sleep(state.delayMs);
      if (url.pathname === '/elsewhere') { state.redirectHit = true; return new Response('{}'); }
      const fp = url.pathname.match(/^\/fingerprint\/([0-9a-f]{32})\/api\/json$/);
      if (fp) {
        const v = state.fingerprints[fp[1]];
        if (v === undefined) return new Response('not found', { status: 404 });
        if (typeof v === 'number') {
          return v >= 300 && v < 400
            ? new Response(null, { status: v, headers: { Location: `${base}elsewhere` } })
            : new Response('err', { status: v });
        }
        return Response.json(v);
      }
      const rec = state.artifacts[url.pathname];
      return rec === undefined ? new Response('not found', { status: 404 }) : Response.json(rec);
    },
  });
  base = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => server?.stop(true));

function reset() {
  Object.assign(state, { fingerprints: {}, artifacts: {}, requests: [], delayMs: 0, redirectHit: false });
}

const opts = (extra = {}) => ({ baseUrl: base, user: USER, token: TOKEN, allowLoopbackHttp: true, ...extra });

describe('digest-lookup 純函式', () => {
  test('fingerprintId 為 MD5(`<digest>\\n`)，不是 MD5(digest)', () => {
    const d = D('b');
    expect(fingerprintId(d)).toBe(md5(`${d}\n`));
    expect(fingerprintId(d)).not.toBe(md5(d));
    for (const bad of ['', 'sha256:ABC', D('b').toUpperCase(), `${D('b')}\n`, null, 42]) {
      expect(() => fingerprintId(bad)).toThrow(TypeError);
    }
  });

  test('fingerprintId：任意合法 digest 產生 32 字元小寫 hex，相異 digest 對應相異 ID', () => {
    fc.assert(
      fc.property(validDigest, validDigest, (a, b) => {
        expect(fingerprintId(a)).toMatch(/^[0-9a-f]{32}$/);
        expect(fingerprintId(a)).toBe(md5(`${a}\n`));
        if (a !== b) expect(fingerprintId(a)).not.toBe(fingerprintId(b));
      }),
      RUNS,
    );
  });

  test('parseJenkinsBase 只接受 HTTPS；loopback HTTP 需明確允許；拒絕 URL 帳密', () => {
    expect(parseJenkinsBase('https://jenkins.lan/ci')).toBe('https://jenkins.lan/ci/');
    expect(() => parseJenkinsBase('http://jenkins.lan/')).toThrow('HTTPS');
    expect(() => parseJenkinsBase('http://127.0.0.1:8080/')).toThrow('HTTPS');
    expect(parseJenkinsBase('http://127.0.0.1:8080/', { allowLoopbackHttp: true })).toBe('http://127.0.0.1:8080/');
    expect(() => parseJenkinsBase('http://10.0.0.5/', { allowLoopbackHttp: true })).toThrow('HTTPS');
    expect(() => parseJenkinsBase('https://u:p@jenkins.lan/')).toThrow('帳號或密碼');
    expect(() => parseJenkinsBase('https://jenkins.lan/?x=1')).toThrow('query');
    expect(() => parseJenkinsBase('not a url')).toThrow(TypeError);
  });

  test('jobPath 逐段編碼並拒絕路徑穿越', () => {
    expect(jobPath('release/little-moments/main')).toBe('job/release/job/little-moments/job/main/');
    expect(jobPath('release/little-moments/feature%2Fx')).toBe('job/release/job/little-moments/job/feature%252Fx/');
    for (const bad of ['release/../admin', 'release//x', '', 'a/b?c', 'a/b#c']) expect(() => jobPath(bad)).toThrow(TypeError);
  });

  test('buildRefsFromFingerprint：range end 不含、去重、只保留 release/little-moments/', () => {
    const { refs, untrusted, truncated } = buildRefsFromFingerprint({
      original: { name: 'release/little-moments/main', number: 12 },
      usage: [
        { name: 'release/little-moments/main', ranges: { ranges: [{ start: 12, end: 14 }] } },
        { name: 'release/little-moments/v1.2.3', ranges: { ranges: [{ start: 3, end: 4 }] } },
        { name: 'ci/little-moments/PR-7', ranges: { ranges: [{ start: 1, end: 3 }] } },
        { name: 'release/little-moments-evil/main', ranges: { ranges: [{ start: 1, end: 2 }] } },
        { name: 'release/little-moments/main', ranges: { ranges: [{ start: 5, end: 5 }, { start: 'x', end: 9 }] } },
      ],
    });
    expect(refs).toEqual([
      { job: 'release/little-moments/main', number: 13 },
      { job: 'release/little-moments/main', number: 12 },
      { job: 'release/little-moments/v1.2.3', number: 3 },
    ]);
    expect(untrusted).toBe(3);
    expect(truncated).toBe(false);
    expect(buildRefsFromFingerprint(null).refs).toEqual([]);
    const big = buildRefsFromFingerprint({ usage: [{ name: 'release/little-moments/main', ranges: { ranges: [{ start: 1, end: 1e9 }] } }] }, { max: 5 });
    expect(big.refs.map((r) => r.number)).toEqual([1e9 - 1, 1e9 - 2, 1e9 - 3, 1e9 - 4, 1e9 - 5]);
    expect(big.truncated).toBe(true);
  });
});

describe('digest-lookup 對 Jenkins stub 查詢', () => {
  test('查得：顯示 main 與 Release_Tag 紀錄的 Commit SHA、Release_Tag、核准人、核准時間與部署時間；忽略 ci/ 偽造紀錄', async () => {
    reset();
    const d = D('c');
    const main = makeRecord({ job: 'release/little-moments/main', number: 12, digest: d });
    const tag = makeRecord({
      job: 'release/little-moments/v1.2.3', number: 3, digest: d, trigger: 'release_tag', ref: 'v1.2.3',
      approval: { approver: 'alice', at: '2025-02-01T10:00:00.000Z', digest: d },
      deployments: [{ env: 'production', at: '2025-02-01T10:05:00.000Z', digest: d, result: 'ok' }],
    });
    const forged = makeRecord({ job: 'ci/little-moments/PR-7', number: 1, digest: d, trigger: 'release_tag', ref: 'v9.9.9', approval: { approver: 'mallory', at: 'x', digest: d } });
    state.fingerprints[md5(`${d}\n`)] = {
      hash: md5(`${d}\n`),
      original: { name: 'release/little-moments/main', number: 12 },
      usage: [
        { name: 'release/little-moments/main', ranges: { ranges: [{ start: 12, end: 13 }] } },
        { name: 'release/little-moments/v1.2.3', ranges: { ranges: [{ start: 3, end: 4 }] } },
        { name: 'ci/little-moments/PR-7', ranges: { ranges: [{ start: 1, end: 2 }] } },
      ],
    };
    state.artifacts[jenkinsPathOf('release/little-moments/main', 12)] = main;
    state.artifacts[jenkinsPathOf('release/little-moments/v1.2.3', 3)] = tag;
    state.artifacts[jenkinsPathOf('ci/little-moments/PR-7', 1)] = forged;

    const res = await lookupDigest(d, opts());
    expect(res.found).toBe(true);
    expect(res.records.map((r) => r.build)).toEqual(['release/little-moments/main#12', 'release/little-moments/v1.2.3#3']);
    const t = res.records[1];
    expect(t).toMatchObject({ digest: d, commit: COMMIT, releaseTag: 'v1.2.3', approver: 'alice', approvedAt: '2025-02-01T10:00:00.000Z', productionDeployedAt: '2025-02-01T10:05:00.000Z' });
    expect(res.records[0].releaseTag).toBe(NOT_APPLICABLE);
    expect(res.skipped.untrusted).toBe(1);
    expect(JSON.stringify(res)).not.toContain('mallory');
    // ci/ 建置的 artifact 從未被請求；token 只出現在 Authorization 標頭，不在 URL。
    expect(state.requests.some((r) => r.url.includes('PR-7'))).toBe(false);
    for (const r of state.requests) {
      expect(r.auth).toBe(`Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.url).not.toContain(USER);
    }
  });

  test('查無：fingerprint 不存在、或可信建置的紀錄都是其他 digest 時，回報查無且不回傳其他紀錄', async () => {
    reset();
    const d = D('d');
    expect(await lookupDigest(d, opts())).toMatchObject({ found: false, records: [], reason: NOT_FOUND_REASON });

    const other = D('e');
    state.fingerprints[md5(`${d}\n`)] = { original: { name: 'release/little-moments/main', number: 4 }, usage: [] };
    state.artifacts[jenkinsPathOf('release/little-moments/main', 4)] = makeRecord({ job: 'release/little-moments/main', number: 4, digest: other });
    const res = await lookupDigest(d, opts());
    expect(res).toMatchObject({ found: false, records: [], reason: NOT_FOUND_REASON });
    expect(JSON.stringify(res)).not.toContain(other);
  });

  test('紀錄 build.job／number 與 fingerprint 來源不符或結構無效者略過；artifact 已刪除者記為 missing', async () => {
    reset();
    const d = D('f');
    state.fingerprints[md5(`${d}\n`)] = {
      usage: [{ name: 'release/little-moments/main', ranges: { ranges: [{ start: 1, end: 4 }] } }],
    };
    state.artifacts[jenkinsPathOf('release/little-moments/main', 1)] = makeRecord({ job: 'release/little-moments/main', number: 99, digest: d });
    state.artifacts[jenkinsPathOf('release/little-moments/main', 2)] = { ...makeRecord({ job: 'release/little-moments/main', number: 2, digest: d }), extra: { x: 1 } };
    const res = await lookupDigest(d, opts());
    expect(res.found).toBe(false);
    expect(res.skipped).toMatchObject({ inconsistent: 2, missing: 1 });
  });

  test('查詢失敗（5xx、401、重新導向、逾時、非 HTTPS）拋出錯誤，不視為查無', async () => {
    reset();
    const d = D('1');
    const id = md5(`${d}\n`);
    state.fingerprints[id] = 500;
    await expect(lookupDigest(d, opts())).rejects.toBeInstanceOf(LookupError);
    state.fingerprints[id] = 401;
    await expect(lookupDigest(d, opts())).rejects.toThrow('認證失敗');
    state.fingerprints[id] = 302;
    await expect(lookupDigest(d, opts())).rejects.toThrow('重新導向');
    expect(state.redirectHit).toBe(false);
    delete state.fingerprints[id];
    state.delayMs = 1500;
    await expect(lookupDigest(d, opts({ totalTimeoutMs: 200 }))).rejects.toThrow('逾時');
    state.delayMs = 0;
    await expect(lookupDigest(d, opts({ allowLoopbackHttp: false }))).rejects.toThrow(TypeError);
    await expect(lookupDigest('sha256:XYZ', opts())).rejects.toThrow('格式無效');
  });

  // Feature: jenkins-cicd-deploy, Property 43: Digest 查詢只回傳相符紀錄（經 fingerprint 查詢路徑）
  // **Validates: Requirements 21.7, 21.8**
  test('Property 43（fingerprint 路徑）：回傳者皆為可信 job、紀錄 digest 等於查詢值；無相符者回報查無', async () => {
    const jobs = ['release/little-moments/main', 'release/little-moments/v1.0.0', 'ci/little-moments/PR-1'];
    const buildArb = fc.record({
      job: fc.constantFrom(...jobs),
      fp: fc.integer({ min: 0, max: 2 }), // image-digest.txt 的 digest（池索引）
      rec: fc.integer({ min: 0, max: 2 }), // Build_Record 中的 digest（池索引；可能與 fp 不同）
    });
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(validDigest, { minLength: 3, maxLength: 3 }),
        fc.array(buildArb, { maxLength: 8 }),
        fc.integer({ min: 0, max: 2 }),
        async (pool, builds, qi) => {
          reset();
          const numbered = builds.map((b, i) => ({ ...b, number: i + 1 }));
          for (const [di, d] of pool.entries()) {
            const users = numbered.filter((b) => b.fp === di);
            if (users.length === 0) continue;
            state.fingerprints[md5(`${d}\n`)] = {
              usage: users.map((b) => ({ name: b.job, ranges: { ranges: [{ start: b.number, end: b.number + 1 }] } })),
            };
          }
          for (const b of numbered) {
            state.artifacts[jenkinsPathOf(b.job, b.number)] = makeRecord({ job: b.job, number: b.number, digest: pool[b.rec] });
          }
          const q = pool[qi];
          const res = await lookupDigest(q, opts());
          const expected = numbered.filter((b) => b.fp === qi && b.rec === qi && b.job.startsWith(TRUSTED_JOB_PREFIX));
          if (expected.length === 0) {
            expect(res).toMatchObject({ found: false, records: [], reason: NOT_FOUND_REASON });
          } else {
            expect(res.found).toBe(true);
            expect(res.records.length).toBe(expected.length);
            for (const r of res.records) {
              expect(r.digest).toBe(q);
              expect(r.build.startsWith(TRUSTED_JOB_PREFIX)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('digest-lookup CLI', () => {
  const run = async (argv, env) => {
    const out = [];
    const err = [];
    const code = await lookupMain(argv, { env, log: (s) => out.push(s), error: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const env = (extra = {}) => ({ JENKINS_URL: base, LM_JENKINS_API_USER: USER, LM_JENKINS_API_TOKEN: TOKEN, LM_LOOKUP_ALLOW_LOOPBACK_HTTP: '1', ...extra });

  test('結束碼：查得 0、查無 1、參數錯誤 2、查詢失敗 3；輸出不含 token', async () => {
    reset();
    const d = D('2');
    state.fingerprints[md5(`${d}\n`)] = { original: { name: 'release/little-moments/v2.0.0', number: 1 } };
    state.artifacts[jenkinsPathOf('release/little-moments/v2.0.0', 1)] = makeRecord({
      job: 'release/little-moments/v2.0.0', number: 1, digest: d, trigger: 'release_tag', ref: 'v2.0.0',
      approval: { approver: 'bob', at: '2025-03-01T00:00:00.000Z', digest: d },
      deployments: [{ env: 'production', at: '2025-03-01T00:10:00.000Z', digest: d, result: 'ok' }],
    });

    const dir = mkdtempSync(join(tmpdir(), 'lm-digest-lookup-'));
    try {
      const outFile = join(dir, 'result.json');
      const found = await run(['--digest', d, '--out', outFile], env());
      expect(found.code).toBe(EXIT.FOUND);
      for (const s of ['Commit SHA：' + COMMIT, 'Release_Tag：v2.0.0', '核准人：bob', '核准時間：2025-03-01T00:00:00.000Z', 'Production 部署時間：2025-03-01T00:10:00.000Z']) {
        expect(found.out).toContain(s);
      }
      expect(JSON.parse(readFileSync(outFile, 'utf8')).found).toBe(true);

      const missing = await run(['--digest', D('3')], env());
      expect(missing.code).toBe(EXIT.NOT_FOUND);
      expect(missing.out).toContain(NOT_FOUND_REASON);

      // token 由檔案提供（Jenkinsfile 使用的方式）。
      const tokenFile = join(dir, 'token');
      writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
      const viaFile = await run(['--digest', d], env({ LM_JENKINS_API_TOKEN: undefined, LM_JENKINS_API_TOKEN_FILE: tokenFile }));
      expect(viaFile.code).toBe(EXIT.FOUND);

      expect((await run(['--digest', 'sha256:abc'], env())).code).toBe(EXIT.USAGE);
      expect((await run([], env())).code).toBe(EXIT.USAGE);
      expect((await run(['--digest', d], env({ LM_JENKINS_API_TOKEN: '' }))).code).toBe(EXIT.USAGE);
      expect((await run(['--digest', d], env({ LM_LOOKUP_ALLOW_LOOPBACK_HTTP: undefined }))).code).toBe(EXIT.USAGE);

      state.fingerprints[md5(`${d}\n`)] = 503;
      const failed = await run(['--digest', d], env());
      expect(failed.code).toBe(EXIT.QUERY_ERROR);
      expect(failed.err).toContain('不視為查無');

      for (const r of [found, missing, viaFile, failed]) {
        expect(r.out + r.err).not.toContain(TOKEN);
        expect(r.out + r.err).not.toContain(Buffer.from(`${USER}:${TOKEN}`).toString('base64'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--main-record-out（Release_Tag 的「映像」關卡）：只寫出 release/little-moments/main 的 main_push 紀錄，取最新者；查無為 1', async () => {
    reset();
    const d = D('4');
    const mainOld = makeRecord({ job: 'release/little-moments/main', number: 20, digest: d });
    const mainNew = makeRecord({ job: 'release/little-moments/main', number: 21, digest: d });
    const tag = makeRecord({ job: 'release/little-moments/v3.0.0', number: 2, digest: d, trigger: 'release_tag', ref: 'v3.0.0' });
    state.fingerprints[md5(`${d}\n`)] = {
      original: { name: 'release/little-moments/main', number: 20 },
      usage: [
        { name: 'release/little-moments/main', ranges: { ranges: [{ start: 20, end: 22 }] } },
        { name: 'release/little-moments/v3.0.0', ranges: { ranges: [{ start: 2, end: 3 }] } },
      ],
    };
    state.artifacts[jenkinsPathOf('release/little-moments/main', 20)] = mainOld;
    state.artifacts[jenkinsPathOf('release/little-moments/main', 21)] = mainNew;
    state.artifacts[jenkinsPathOf('release/little-moments/v3.0.0', 2)] = tag;
    const dir = mkdtempSync(join(tmpdir(), 'lm-digest-lookup-main-'));
    try {
      const outFile = join(dir, 'main-build-record.json');
      const found = await run(['--digest', d, '--commit', COMMIT, '--main-record-out', outFile], env());
      expect(found.code).toBe(EXIT.FOUND);
      const rec = JSON.parse(readFileSync(outFile, 'utf8'));
      expect(rec.build).toMatchObject({ job: 'release/little-moments/main', number: 21 });
      expect(rec.source).toMatchObject({ trigger: 'main_push', commit: COMMIT });
      expect(JSON.stringify(rec)).not.toContain(TOKEN);
      // 完整紀錄不出現在主控台輸出。
      expect(found.out).not.toContain('"schema"');

      const other = await run(['--digest', d, '--commit', 'b'.repeat(40), '--main-record-out', join(dir, 'x.json')], env());
      expect(other.code).toBe(EXIT.NOT_FOUND);
      expect((await run(['--digest', d, '--main-record-out', outFile], env())).code).toBe(EXIT.USAGE);
      expect((await run(['--digest', d, '--commit', COMMIT], env())).code).toBe(EXIT.USAGE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const { selectMainRecord } = await import('../ci/digest-lookup.mjs');
    const entries = [
      { ref: { job: 'release/little-moments/main', number: 21 }, rec: mainNew },
      { ref: { job: 'release/little-moments/v3.0.0', number: 2 }, rec: tag },
      { ref: { job: 'release/little-moments/main', number: 99 }, rec: mainOld }, // build.number 與 ref 不符
    ];
    expect(selectMainRecord(entries, { commit: COMMIT, digest: d })).toBe(mainNew);
    expect(selectMainRecord(entries, { commit: COMMIT, digest: D('5') })).toBeNull();
    expect(selectMainRecord(entries, { commit: 'bad', digest: d })).toBeNull();
  });

  test('Jenkinsfile：唯一參數為 DIGEST、單引號 sh、憑證只在 withCredentials 內、Build_Image 以 digest 引用', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'ci', 'jenkins', 'pipelines', 'digest-lookup.Jenkinsfile'), 'utf8');
    expect(src.match(/string\(name: '([A-Z_]+)'/g)).toEqual(["string(name: 'DIGEST'"]);
    expect(src).not.toMatch(/booleanParam|choice\(|SKIP|BYPASS/i);
    expect(src).toContain("BUILD_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/build-image@sha256:<digest>'");
    expect(src).toContain('bun ci/digest-lookup.mjs --digest "$LM_DIGEST" --out "$LM_LOOKUP_OUT"');
    expect(src).toContain('查無對應紀錄');
    // 所有 sh 腳本皆為單引號或三個單引號字串（不經 Groovy 插值）。
    for (const m of src.matchAll(/script:\s*(\S{1,3})/g)) expect(m[1].startsWith("'")).toBe(true);
    expect(src).not.toMatch(/sh\s*\(?\s*"/);
    expect(src).not.toMatch(/LM_JENKINS_API_TOKEN=\$\{/);
  });
});
