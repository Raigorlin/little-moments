// Feature: jenkins-cicd-deploy, Property 47: Release_Tag 的 digest 解析與版本標籤
// **Validates: Requirements 1.4, 1.10, 16.6, 16.10, 19.5**
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  EXIT,
  STAGING_PREDICATE_TYPE,
  checkMainRecord,
  checkSignatureOutput,
  checkStagingAttestation,
  classifyCraneDigest,
  main,
  resolveReleaseDigest,
  versionTagDecision,
} from '../ci/resolve-digest.mjs';

const RUNS = { numRuns: 200 };

// 外部工具 stderr／例外訊息內的標記；任何輸出都不得出現（不回顯原始 stderr）。
const MARKER = 'LEAK-MARKER-7f3a9c';

// ---------------------------------------------------------------- 產生器

const HEX = '0123456789abcdef'.split('');
const hex = n => fc.array(fc.constantFrom(...HEX), { minLength: n, maxLength: n }).map(a => a.join(''));
const commitArb = hex(40);
const digestArb = hex(64).map(h => `sha256:${h}`);
const tagArb = fc
  .record({ a: fc.integer({ min: 0, max: 999 }), b: fc.integer({ min: 0, max: 999 }), c: fc.integer({ min: 0, max: 999 }) })
  .map(({ a, b, c }) => `v${a}.${b}.${c}`);
const repoArb = fc.constantFrom('registry.lan:5000/little-moments', 'reg.example/team/little-moments', 'localhost:5000/lm/app');

/** 由 d 產生一定不同的 digest。 */
function otherDigest(d, salt) {
  const h = d.slice(7).split('');
  const i = salt % 64;
  h[i] = h[i] === '0' ? '1' : '0';
  return `sha256:${h.join('')}`;
}

// ---------------------------------------------------------------- 獨立 oracle（純函式）

function oracleResolve(facts, through) {
  const order = { lookup: 0, image: 1, staging: 2 }[through];
  const commitOk = typeof facts.commit === 'string' && /^[0-9a-f]{40}$/.test(facts.commit);
  if (!commitOk) return { ok: false, code: EXIT.USAGE, gate: 'Resolve Digest' };
  const t = facts.shaTagDigest;
  if (t && t.kind === 'not_found') return { ok: false, code: EXIT.NOT_FOUND, gate: 'Resolve Digest' };
  const validDigest = t && t.kind === 'found' && typeof t.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(t.digest);
  if (!validDigest) return { ok: false, code: EXIT.REGISTRY_ERROR, gate: 'Resolve Digest' };
  if (order === 0) return { ok: true, digest: t.digest };
  if (facts.signatureOk !== true || facts.sbomRecorded !== true) return { ok: false, code: EXIT.IMAGE_GATE, gate: '映像' };
  if (order === 1) return { ok: true, digest: t.digest };
  if (facts.stagingVerified !== true) return { ok: false, code: EXIT.STAGING_GATE, gate: 'Staging' };
  return { ok: true, digest: t.digest };
}

describe('Property 47: resolveReleaseDigest 純函式', () => {
  const loose = fc.constantFrom(true, false, undefined, 1, 'true', null);
  const shaTagArb = fc.oneof(
    digestArb.map(digest => ({ kind: 'found', digest })),
    fc.constantFrom('sha256:xyz', '', 'sha256:' + 'A'.repeat(64), undefined).map(digest => ({ kind: 'found', digest })),
    fc.constant({ kind: 'not_found' }),
    fc.constantFrom('認證失敗', undefined).map(reason => ({ kind: 'error', reason })),
    fc.constant(undefined),
    fc.constant({ kind: 'weird' }),
  );
  const commitish = fc.oneof(commitArb, fc.constantFrom('abc', 'G'.repeat(40), 'A'.repeat(40), undefined, ''));

  test('依 lookup → 映像 → Staging 順序評估，第一個未通過者決定結果', () => {
    fc.assert(
      fc.property(
        commitish, shaTagArb, loose, loose, loose, fc.constantFrom('lookup', 'image', 'staging'),
        (commit, shaTagDigest, signatureOk, sbomRecorded, stagingVerified, through) => {
          const facts = { commit, shaTagDigest, signatureOk, sbomRecorded, stagingVerified };
          const got = resolveReleaseDigest(facts, { through });
          const want = oracleResolve(facts, through);
          expect(got.ok).toBe(want.ok);
          if (want.ok) {
            // 成功時 digest 恰為完整 SHA 標籤所指向者
            expect(got.digest).toBe(shaTagDigest.digest);
          } else {
            expect(got.code).toBe(want.code);
            expect(got.gate).toBe(want.gate);
            if (want.code === EXIT.NOT_FOUND) {
              expect(got.reason).toContain('查無 Image_Digest');
              expect(got.reason).toContain(commit);
            }
            if (want.code === EXIT.REGISTRY_ERROR) expect(got.reason.startsWith('Registry 查詢失敗')).toBe(true);
          }
        },
      ),
      RUNS,
    );
  });

  test('預設 through 為 staging；未知步驟拋出 RangeError', () => {
    fc.assert(
      fc.property(commitArb, digestArb, (commit, digest) => {
        const facts = { commit, shaTagDigest: { kind: 'found', digest }, signatureOk: true, sbomRecorded: true };
        expect(resolveReleaseDigest(facts).code).toBe(EXIT.STAGING_GATE);
        expect(resolveReleaseDigest({ ...facts, stagingVerified: true })).toEqual({ ok: true, digest });
        expect(() => resolveReleaseDigest(facts, { through: 'prod' })).toThrow(RangeError);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property 47: versionTagDecision 絕不覆寫', () => {
  test('不存在 → create；相同 → noop；不同 → conflict', () => {
    fc.assert(
      fc.property(digestArb, fc.nat(), fc.constantFrom('none', 'undef', 'same', 'other'), (digest, salt, kind) => {
        const existing = { none: null, undef: undefined, same: digest, other: otherDigest(digest, salt) }[kind];
        const want = { none: 'create', undef: 'create', same: 'noop', other: 'conflict' }[kind];
        expect(versionTagDecision(existing, digest)).toBe(want);
      }),
      RUNS,
    );
  });

  test('digest 格式無效時拋出 TypeError', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), hex(64), fc.constant(undefined)), bad => {
        fc.pre(!/^sha256:[0-9a-f]{64}$/.test(String(bad)));
        expect(() => versionTagDecision(null, bad)).toThrow(TypeError);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------- classifyCraneDigest

const noise = fc.array(fc.constantFrom('x', 'y', 'z', ' ', '_', ':', '-'), { maxLength: 12 }).map(a => a.join(''));
const stderrCase = fc.oneof(
  // crane 實際輸出在錯誤碼前有分隔字元（例如 "Error: MANIFEST_UNKNOWN"），故 noise 與錯誤碼之間加空白
  fc.tuple(noise, noise).map(([a, b]) => ({ stderr: `${a} MANIFEST_UNKNOWN: manifest unknown${b}`, want: 'not_found' })),
  fc.tuple(noise, fc.constantFrom('', ' Not Found', '\n')).map(([a, b]) => ({ stderr: `${a} HEAD https://r/v2/x: unexpected status code 404${b}`, want: 'not_found' })),
  fc.tuple(noise, fc.constantFrom('UNAUTHORIZED', 'DENIED', 'unexpected status code 401', 'unexpected status code 403')).map(([a, t]) => ({ stderr: `${a} ${t} `, want: 'error' })),
  fc.tuple(noise, fc.constantFrom('500', '502', '503')).map(([a, c]) => ({ stderr: `${a} unexpected status code ${c} `, want: 'error' })),
  noise.map(a => ({ stderr: `${a} NAME_UNKNOWN: repository name not known`, want: 'error' })),
  noise.map(a => ({ stderr: `${a} dial tcp 10.0.0.9:5000: connect: connection refused`, want: 'error' })),
);

describe('Property 47: classifyCraneDigest', () => {
  test('MANIFEST_UNKNOWN／404 → not_found；認證、5xx、NAME_UNKNOWN、網路錯誤 → error', () => {
    fc.assert(
      fc.property(stderrCase, fc.integer({ min: 1, max: 255 }), ({ stderr, want }, status) => {
        const got = classifyCraneDigest({ status, stdout: '', stderr: `${stderr} ${MARKER}` });
        expect(got.kind).toBe(want);
        expect(JSON.stringify(got)).not.toContain(MARKER);
      }),
      RUNS,
    );
  });

  test('成功時只接受有效 digest；執行例外一律為 error', () => {
    fc.assert(
      fc.property(digestArb, fc.constantFrom('', '\n', '  \r\n'), fc.string(), (digest, ws, junk) => {
        expect(classifyCraneDigest({ status: 0, stdout: digest + ws, stderr: '' })).toEqual({ kind: 'found', digest });
        fc.pre(!/^sha256:[0-9a-f]{64}$/.test(junk.trim()));
        expect(classifyCraneDigest({ status: 0, stdout: junk, stderr: '' }).kind).toBe('error');
        const e = classifyCraneDigest({ status: null, error: new Error(MARKER), stdout: digest, stderr: 'MANIFEST_UNKNOWN' });
        expect(e.kind).toBe('error');
        expect(JSON.stringify(e)).not.toContain(MARKER);
        expect(classifyCraneDigest(null).kind).toBe('error');
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------- cosign 與 Build_Record 輸出建構

const sigOutput = (digest, extra = []) =>
  JSON.stringify([...extra, { critical: { image: { 'docker-manifest-digest': digest }, type: 'cosign container image signature' } }]);

function envelope(statement) {
  return JSON.stringify({ payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') });
}
function statement({ digest, commit, smoke = 'pass', type = STAGING_PREDICATE_TYPE }) {
  return {
    _type: 'https://in-toto.io/Statement/v0.1',
    predicateType: type,
    subject: [{ name: 'r/x', digest: { sha256: digest.slice(7) } }],
    predicate: { commit, verifiedAt: '2026-01-01T00:00:00Z', build: 'b#1', healthChecks: 3, smoke },
  };
}
function mainRecord({ commit, digest, sbom = 'reports/sbom.json', trigger = 'main_push' }) {
  return { schema: 1, source: { commit, trigger, ref: 'main' }, image: { digest }, reports: { sbom } };
}

describe('Property 47: 輔助檢查函式', () => {
  test('checkSignatureOutput 只在某筆簽章對象為該 digest 時為真', () => {
    fc.assert(
      fc.property(digestArb, fc.nat(), fc.boolean(), (digest, salt, withOther) => {
        const other = otherDigest(digest, salt);
        const extra = withOther ? [{ critical: { image: { 'docker-manifest-digest': other } } }] : [];
        expect(checkSignatureOutput(sigOutput(digest, extra), digest)).toBe(true);
        expect(checkSignatureOutput(sigOutput(other), digest)).toBe(false);
        expect(checkSignatureOutput('[]', digest)).toBe(false);
        expect(checkSignatureOutput('not json', digest)).toBe(false);
        expect(checkSignatureOutput(sigOutput(digest), 'sha256:bad')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test('checkStagingAttestation 需 predicateType、subject、commit 與 smoke 皆相符', () => {
    fc.assert(
      fc.property(digestArb, commitArb, commitArb, fc.nat(), (digest, commit, otherCommit, salt) => {
        fc.pre(commit !== otherCommit);
        const ok = { commit, digest };
        expect(checkStagingAttestation(envelope(statement(ok)), ok)).toBe(true);
        expect(checkStagingAttestation(`garbage\n\n${envelope(statement(ok))}\n`, ok)).toBe(true);
        expect(checkStagingAttestation(envelope(statement({ ...ok, commit: otherCommit })), ok)).toBe(false);
        expect(checkStagingAttestation(envelope(statement({ ...ok, smoke: 'fail' })), ok)).toBe(false);
        expect(checkStagingAttestation(envelope(statement({ ...ok, type: 'https://other/v1' })), ok)).toBe(false);
        expect(checkStagingAttestation(envelope(statement({ ...ok, digest: otherDigest(digest, salt) })), ok)).toBe(false);
        expect(checkStagingAttestation('', ok)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test('checkMainRecord 需 main_push、相同 commit／digest 且 SBOM 已封存', () => {
    fc.assert(
      fc.property(digestArb, commitArb, commitArb, fc.nat(), (digest, commit, otherCommit, salt) => {
        fc.pre(commit !== otherCommit);
        const ok = { commit, digest };
        expect(checkMainRecord(mainRecord(ok), ok)).toBe(true);
        expect(checkMainRecord(mainRecord({ ...ok, commit: otherCommit }), ok)).toBe(false);
        expect(checkMainRecord(mainRecord({ ...ok, digest: otherDigest(digest, salt) }), ok)).toBe(false);
        for (const sbom of ['不適用', '未執行', '', '  ', undefined, 3]) {
          const rec = mainRecord(ok);
          rec.reports.sbom = sbom; // 直接指定，避免 undefined 觸發預設參數
          expect(checkMainRecord(rec, ok)).toBe(false);
        }
        expect(checkMainRecord(mainRecord({ ...ok, trigger: 'release_tag' }), ok)).toBe(false);
        expect(checkMainRecord(null, ok)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------- main()：注入假的 spawn／readFile

let dir;
let keyPath;
let recordPath;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lm-resolve-digest-'));
  keyPath = join(dir, 'cosign.pub');
  recordPath = join(dir, 'build-record.json');
  writeFileSync(keyPath, '-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----\n');
  writeFileSync(recordPath, '{}');
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const scenarioArb = fc.record({
  repo: repoArb,
  commit: commitArb,
  tag: tagArb,
  digest: digestArb,
  salt: fc.nat(),
  otherCommit: commitArb,
  shaTag: fc.constantFrom('found', 'not_found_manifest', 'not_found_404', 'auth', 'name_unknown', 'server', 'network', 'spawnError', 'badStdout'),
  sig: fc.constantFrom('ok', 'okWithOther', 'wrongDigest', 'empty', 'notJson', 'nonzero', 'spawnError'),
  record: fc.constantFrom('valid', 'wrongCommit', 'wrongDigest', 'noSbom', 'sbomNotRun', 'wrongTrigger', 'notJson', 'readThrows'),
  existing: fc.constantFrom('none', 'same', 'other', 'error', 'spawnError'),
  tagRes: fc.constantFrom('ok', 'fail', 'spawnError'),
  after: fc.constantFrom('same', 'other', 'none', 'error'),
  att: fc.constantFrom('valid', 'validWithGarbage', 'wrongCommit', 'smokeFail', 'wrongType', 'wrongSubject', 'garbage', 'nonzero', 'spawnError'),
});

const spawnError = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error(`spawn ENOENT ${MARKER}`), { code: 'ENOENT' }) });
const okOut = stdout => ({ status: 0, stdout, stderr: '' });
const failOut = (stderr, stdout = '') => ({ status: 1, stdout, stderr: `${stderr} ${MARKER}` });

function craneDigestResponse(kind, digest) {
  switch (kind) {
    // 'other'：版本標籤已存在且指向呼叫端傳入的另一個 digest（runMain 傳入 otherDigest）。
    case 'found': case 'same': case 'other': return okOut(`${digest}\n`);
    case 'not_found_manifest': case 'none': return failOut('Error: MANIFEST_UNKNOWN: manifest unknown');
    case 'not_found_404': return failOut('Error: HEAD https://r/v2/x/manifests/y: unexpected status code 404 Not Found (HEAD responses have no body)');
    case 'auth': return failOut('Error: UNAUTHORIZED: authentication required');
    case 'name_unknown': return failOut('Error: NAME_UNKNOWN: repository name not known to registry');
    case 'server': case 'error': return failOut('Error: unexpected status code 503 Service Unavailable');
    case 'network': return failOut('Error: dial tcp 10.0.0.9:5000: connect: connection refused');
    case 'spawnError': return spawnError();
    case 'badStdout': return okOut(`not-a-digest ${MARKER}\n`);
    default: throw new Error(`未知情境 ${kind}`);
  }
}

/** 獨立 oracle：預期的外部呼叫序列與結束碼。 */
function oracleMain(s) {
  const calls = ['crane digest sha'];
  const done = code => ({ calls, code });
  if (s.shaTag.startsWith('not_found')) return done(EXIT.NOT_FOUND);
  if (s.shaTag !== 'found') return done(EXIT.REGISTRY_ERROR);
  calls.push('cosign verify');
  if (s.sig === 'spawnError') return done(EXIT.TOOL);
  if (!(s.sig === 'ok' || s.sig === 'okWithOther') || s.record !== 'valid') return done(EXIT.IMAGE_GATE);
  calls.push('crane digest tag');
  if (s.existing === 'error' || s.existing === 'spawnError') return done(EXIT.REGISTRY_ERROR);
  if (s.existing === 'other') return done(EXIT.TAG_CONFLICT);
  let decision = 'noop';
  if (s.existing === 'none') {
    decision = 'create';
    calls.push('crane tag');
    if (s.tagRes === 'spawnError') return done(EXIT.TOOL);
    if (s.tagRes === 'fail') return done(EXIT.REGISTRY_ERROR);
    calls.push('crane digest tag');
    if (s.after !== 'same') return done(EXIT.TAG_CONFLICT);
  }
  calls.push('cosign verify-attestation');
  if (s.att === 'spawnError') return done(EXIT.TOOL);
  if (!(s.att === 'valid' || s.att === 'validWithGarbage')) return done(EXIT.STAGING_GATE);
  return { calls, code: EXIT.OK, decision };
}

function runMain(s) {
  const { repo, commit, tag, digest } = s;
  const other = otherDigest(digest, s.salt);
  const otherCommit = s.otherCommit === commit ? commit.replace(/^./, c => (c === 'a' ? 'b' : 'a')) : s.otherCommit;
  const ref = `${repo}@${digest}`;
  const calls = [];
  let tagDigestCalls = 0;

  const spawn = (cmd, args, opts) => {
    expect(opts.shell).toBe(false);
    if (cmd === 'crane' && args[0] === 'digest') {
      if (args[1] === `${repo}:${commit}`) {
        calls.push('crane digest sha');
        return craneDigestResponse(s.shaTag, digest);
      }
      expect(args[1]).toBe(`${repo}:${tag}`);
      calls.push('crane digest tag');
      tagDigestCalls += 1;
      const kind = tagDigestCalls === 1 ? s.existing : s.after;
      return craneDigestResponse(kind, kind === 'other' ? other : digest);
    }
    if (cmd === 'crane' && args[0] === 'tag') {
      calls.push('crane tag');
      // 以 digest 參照加上版本標籤（不以標籤參照）
      expect(args).toEqual(['tag', ref, tag]);
      if (s.tagRes === 'spawnError') return spawnError();
      return s.tagRes === 'ok' ? okOut('') : failOut('Error: PUT failed');
    }
    if (cmd === 'cosign' && args[0] === 'verify') {
      calls.push('cosign verify');
      expect(args).toContain(resolve(keyPath));
      expect(args[args.length - 1]).toBe(ref);
      switch (s.sig) {
        case 'ok': return okOut(sigOutput(digest));
        case 'okWithOther': return okOut(sigOutput(digest, [{ critical: { image: { 'docker-manifest-digest': other } } }]));
        case 'wrongDigest': return okOut(sigOutput(other));
        case 'empty': return okOut('[]');
        case 'notJson': return okOut(`Verification for ${MARKER}`);
        case 'nonzero': return failOut('Error: no matching signatures', sigOutput(digest));
        case 'spawnError': return spawnError();
      }
    }
    if (cmd === 'cosign' && args[0] === 'verify-attestation') {
      calls.push('cosign verify-attestation');
      expect(args).toContain(resolve(keyPath));
      expect(args).toContain(STAGING_PREDICATE_TYPE);
      expect(args[args.length - 1]).toBe(ref);
      const good = envelope(statement({ digest, commit }));
      switch (s.att) {
        case 'valid': return okOut(`${good}\n`);
        case 'validWithGarbage': return okOut(`{oops\n${good}\n\n`);
        case 'wrongCommit': return okOut(envelope(statement({ digest, commit: otherCommit })));
        case 'smokeFail': return okOut(envelope(statement({ digest, commit, smoke: 'fail' })));
        case 'wrongType': return okOut(envelope(statement({ digest, commit, type: 'https://example.invalid/other/v1' })));
        case 'wrongSubject': return okOut(envelope(statement({ digest: other, commit })));
        case 'garbage': return okOut(`${MARKER}\n`);
        case 'nonzero': return failOut('Error: none of the attestations matched', good);
        case 'spawnError': return spawnError();
      }
    }
    throw new Error(`未預期的呼叫 ${cmd} ${args.join(' ')}`);
  };

  const readFile = p => {
    expect(p).toBe(resolve(recordPath));
    switch (s.record) {
      case 'valid': return JSON.stringify(mainRecord({ commit, digest }));
      case 'wrongCommit': return JSON.stringify(mainRecord({ commit: otherCommit, digest }));
      case 'wrongDigest': return JSON.stringify(mainRecord({ commit, digest: other }));
      case 'noSbom': return JSON.stringify({ ...mainRecord({ commit, digest }), reports: {} });
      case 'sbomNotRun': return JSON.stringify(mainRecord({ commit, digest, sbom: '未執行' }));
      case 'wrongTrigger': return JSON.stringify(mainRecord({ commit, digest, trigger: 'release_tag' }));
      case 'notJson': return `{${MARKER}`;
      case 'readThrows': throw new Error(`EACCES ${MARKER}`);
    }
  };

  const logs = [];
  const errors = [];
  const argv = ['--repo', repo, '--commit', commit, '--tag', tag, '--key', keyPath, '--main-record', recordPath];
  const code = main(argv, { log: m => logs.push(String(m)), error: m => errors.push(String(m)), spawn, readFile });
  return { code, calls, logs, errors, ref };
}

describe('Property 47: main() 端到端（假的 crane／cosign）', () => {
  test('呼叫序列與結束碼符合 oracle；衝突不呼叫 crane tag；成功輸出 repo@digest；不回顯原始 stderr', () => {
    fc.assert(
      fc.property(scenarioArb, s => {
        const want = oracleMain(s);
        const got = runMain(s);

        expect(got.code).toBe(want.code);
        expect(got.calls).toEqual(want.calls);
        if (s.existing === 'other') expect(got.calls).not.toContain('crane tag');
        // 未通過「映像」關卡前不得寫入版本標籤或查 attestation
        if ([EXIT.NOT_FOUND, EXIT.REGISTRY_ERROR, EXIT.IMAGE_GATE].includes(got.code) && !got.calls.includes('crane digest tag')) {
          expect(got.calls).not.toContain('crane tag');
          expect(got.calls).not.toContain('cosign verify-attestation');
        }

        const all = [...got.logs, ...got.errors].join('\n');
        expect(all).not.toContain(MARKER);

        const out = got.code === EXIT.OK ? got.logs : got.errors;
        expect(got.code === EXIT.OK ? got.errors : got.logs).toEqual([]);
        expect(out).toHaveLength(1);
        const body = JSON.parse(out[0]);
        expect(body.commit).toBe(s.commit);
        expect(body.tag).toBe(s.tag);

        if (got.code === EXIT.OK) {
          expect(body.ok).toBe(true);
          expect(body.digest).toBe(s.digest);
          expect(body.ref).toBe(got.ref);
          expect(body.ref).toBe(`${s.repo}@${s.digest}`);
          expect(body.versionTag).toBe(want.decision);
        } else {
          expect(body.ok).toBe(false);
          expect(typeof body.stage).toBe('string');
          if (got.code === EXIT.NOT_FOUND) {
            expect(body.stage).toBe('Resolve Digest');
            expect(body.reason).toContain('查無 Image_Digest');
          }
          if (got.code === EXIT.REGISTRY_ERROR) expect(body.reason).toContain('Registry 查詢失敗');
          if (got.code === EXIT.IMAGE_GATE) expect(body.gate).toBe('映像');
          if (got.code === EXIT.TAG_CONFLICT) {
            expect(body.stage).toBe('Version Tag');
            expect(body.reason).toContain('拒絕覆寫');
          }
          if (got.code === EXIT.STAGING_GATE) expect(body.gate).toBe('Staging');
          if (got.code === EXIT.TOOL) expect(body.reason).toContain('無法執行');
        }
      }),
      { numRuns: 400 },
    );
  });

  test('參數錯誤以結束碼 6 結束且不呼叫外部工具', () => {
    const bad = fc.constantFrom('missing', 'unknownFlag', 'badCommit', 'upperCommit', 'badTag', 'badRepo', 'dashRepo', 'noKey', 'dashKey', 'noRecord', 'badPredicate');
    fc.assert(
      fc.property(bad, repoArb, commitArb, tagArb, (kind, repo, commit, tag) => {
        const a = { '--repo': repo, '--commit': commit, '--tag': tag, '--key': keyPath, '--main-record': recordPath };
        let argv;
        switch (kind) {
          case 'missing': delete a['--key']; break;
          case 'unknownFlag': a['--force'] = 'yes'; break;
          case 'badCommit': a['--commit'] = commit.slice(1); break;
          case 'upperCommit': a['--commit'] = commit.toUpperCase().replace(/^[0-9]/, 'A'); break;
          case 'badTag': a['--tag'] = `${tag}-rc.1`; break;
          case 'badRepo': a['--repo'] = `${repo}:latest`; break;
          case 'dashRepo': a['--repo'] = `-${repo}`; break;
          case 'noKey': a['--key'] = join(dir, 'missing.pub'); break;
          case 'dashKey': a['--key'] = '-oops'; break;
          case 'noRecord': a['--main-record'] = join(dir, 'missing.json'); break;
          case 'badPredicate': a['--predicate-type'] = 'not a uri'; break;
        }
        argv = Object.entries(a).flat();
        if (kind === 'missing') argv.push('--key');
        const spawn = () => { throw new Error('不應呼叫外部工具'); };
        const errors = [];
        const code = main(argv, { log: () => { throw new Error('不應輸出至 stdout'); }, error: m => errors.push(String(m)), spawn, readFile: spawn });
        expect(code).toBe(EXIT.USAGE);
        expect(errors.length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------- 分段 CLI（根目錄 Jenkinsfile 的 Release_Tag 階段，Task 13.7）

describe('step CLI：Agent 上蒐集 crane／cosign 結果，Build_Image 內判讀', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-resolve-step-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const C = 'c'.repeat(40);
  const DG = `sha256:${'d'.repeat(64)}`;
  const OTHER = `sha256:${'e'.repeat(64)}`;
  const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const run = (argv) => {
    const out = [];
    const code = main(['step', ...argv], { log: (s) => out.push(s), error: (s) => out.push(s) });
    return { code, out: out.join('\n') };
  };
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const sig = JSON.stringify([{ critical: { image: { 'docker-manifest-digest': DG } } }]);
  const att = (commit, digest = DG) => JSON.stringify({
    payload: Buffer.from(JSON.stringify({
      predicateType: STAGING_PREDICATE_TYPE, subject: [{ digest: { sha256: digest.slice(7) } }], predicate: { commit, smoke: 'pass' },
    })).toString('base64'),
  }) + '\n';
  const mainRecord = { source: { trigger: 'main_push', commit: C }, image: { digest: DG }, reports: { sbom: 'reports/sbom.cdx.json' } };

  test('lookup：查得 0、查無 1（Req 1.10）、Registry 錯誤 2（不視為查無）', () => {
    const out = join(dir, 'lookup.json');
    expect(run(['lookup', '--commit', C, '--exit', '0', '--stdout', file('o1', `${DG}\n`), '--stderr', file('e1', ''), '--out', out]).code).toBe(EXIT.OK);
    expect(readJson(out)).toEqual({ ok: true, commit: C, digest: DG });
    const nf = run(['lookup', '--commit', C, '--exit', '1', '--stdout', file('o2', ''), '--stderr', file('e2', 'MANIFEST_UNKNOWN: manifest unknown'), '--out', join(dir, 'l2.json')]);
    expect(nf.code).toBe(EXIT.NOT_FOUND);
    expect(readJson(join(dir, 'l2.json')).reason).toContain('查無 Image_Digest');
    expect(run(['lookup', '--commit', C, '--exit', '1', '--stdout', file('o3', ''), '--stderr', file('e3', 'UNAUTHORIZED'), '--out', join(dir, 'l3.json')]).code).toBe(EXIT.REGISTRY_ERROR);
    expect(run(['lookup', '--commit', C, '--exit', 'x', '--stdout', 'a', '--stderr', 'b', '--out', 'c']).code).toBe(EXIT.USAGE);
  });

  test('image：簽章對象為該 digest 且 main Build_Record 記錄 commit、digest 與 SBOM 才通過；結果為 record.mjs gate 的輸入', () => {
    const lookup = file('lookup-ok.json', JSON.stringify({ ok: true, commit: C, digest: DG }));
    const gate = join(dir, 'gate-image.json');
    const args = (sigExit, sigText, rec) => ['image', '--commit', C, '--lookup', lookup, '--signature-exit', sigExit, '--signature', file(`s${sigExit}`, sigText), '--main-record', file(`m${sigExit}`, JSON.stringify(rec)), '--out-gate', gate];
    expect(run(args('0', sig, mainRecord)).code).toBe(EXIT.OK);
    expect(readJson(gate)).toMatchObject({ gate: '映像', pass: true, status: 'pass', commit: C, unmet: [] });
    expect(run(args('1', sig, mainRecord)).code).toBe(EXIT.IMAGE_GATE);
    expect(readJson(gate).unmet[0]).toContain('簽章驗證未通過');
    expect(run(args('0', sig, { ...mainRecord, reports: {} })).code).toBe(EXIT.IMAGE_GATE);
    expect(readJson(gate).unmet).toEqual([expect.stringContaining('SBOM')]);
    const badLookup = file('lookup-bad.json', JSON.stringify({ ok: true, commit: 'f'.repeat(40), digest: DG }));
    expect(run(['image', '--commit', C, '--lookup', badLookup, '--signature-exit', '0', '--signature', file('s9', sig), '--main-record', file('m9', JSON.stringify(mainRecord)), '--out-gate', gate]).code).toBe(EXIT.IMAGE_GATE);
  });

  test('staging：需「映像」關卡通過，且 attestation 的 commit 相符（Req 19.5）', () => {
    const lookup = file('lookup-ok2.json', JSON.stringify({ ok: true, commit: C, digest: DG }));
    const imageGate = file('gi.json', JSON.stringify({ gate: '映像', pass: true, commit: C }));
    const gate = join(dir, 'gate-staging.json');
    const args = (g, text, exit = '0') => ['staging', '--commit', C, '--lookup', lookup, '--image-gate', g, '--attestation-exit', exit, '--attestation', file('att', text), '--out-gate', gate];
    expect(run(args(imageGate, att(C))).code).toBe(EXIT.OK);
    expect(readJson(gate)).toMatchObject({ gate: 'Staging', pass: true });
    expect(run(args(imageGate, att('f'.repeat(40)))).code).toBe(EXIT.STAGING_GATE);
    expect(readJson(gate).unmet[0]).toContain('缺少 Staging 驗證');
    expect(run(args(imageGate, att(C), '1')).code).toBe(EXIT.STAGING_GATE);
    const failedImage = file('gi2.json', JSON.stringify({ gate: '映像', pass: false, commit: C }));
    expect(run(args(failedImage, att(C))).code).toBe(EXIT.STAGING_GATE);
    expect(readJson(gate).unmet[0]).toContain('「映像」關卡未通過');
  });

  test('version-tag：不存在 → create、相同 → noop、不同 → 4（拒絕覆寫）、Registry 錯誤 → 2；寫入後確認', () => {
    const out = join(dir, 'vt.json');
    const vt = (exit, stdout, stderr) => run(['version-tag', '--digest', DG, '--exit', exit, '--stdout', file('vo', stdout), '--stderr', file('ve', stderr), '--out', out]);
    expect(vt('1', '', 'MANIFEST_UNKNOWN').code).toBe(EXIT.OK);
    expect(readJson(out).decision).toBe('create');
    expect(vt('0', `${DG}\n`, '').code).toBe(EXIT.OK);
    expect(readJson(out).decision).toBe('noop');
    expect(vt('0', `${OTHER}\n`, '').code).toBe(EXIT.TAG_CONFLICT);
    expect(readJson(out)).toMatchObject({ decision: 'conflict', existingDigest: OTHER });
    expect(vt('1', '', 'status code 503').code).toBe(EXIT.REGISTRY_ERROR);
    const verify = (exit, stdout) => run(['version-tag-verify', '--digest', DG, '--exit', exit, '--stdout', file('ao', stdout), '--stderr', file('ae', '')]).code;
    expect(verify('0', `${DG}\n`)).toBe(EXIT.OK);
    expect(verify('0', `${OTHER}\n`)).toBe(EXIT.TAG_CONFLICT);
    expect(verify('1', '')).toBe(EXIT.TAG_CONFLICT);
  });

  test('未知的 step 子命令或參數為用法錯誤', () => {
    expect(run(['bogus']).code).toBe(EXIT.USAGE);
    expect(run(['lookup', '--commit']).code).toBe(EXIT.USAGE);
  });
});
