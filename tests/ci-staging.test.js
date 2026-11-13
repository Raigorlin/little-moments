// ci/staging.mjs：Staging 部署判讀、還原、staging-verified predicate、Build_Record 與「Staging」關卡
// （Req 14.3、14.8、17.8、18.1–18.5、18.7、18.8、23.2、23.5；Property 40 的 Staging 套用、Property 45 的 fail closed）。
import { afterAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { healthyWithin } from '../ci/health.mjs';
import { addGateResult, createRecord, mergeRecord, validateRecord } from '../ci/record.mjs';
import { STAGING_PREDICATE_TYPE as RESOLVE_TYPE, checkStagingAttestation } from '../ci/resolve-digest.mjs';
import {
  STAGING_PREDICATE_TYPE, buildPredicate, classifyDeploy, classifyRestore, healthCadenceOk, main, parseSmoke,
  parseStatus, rollbackNeeded, stagingRecord, stagingVerdict,
} from '../ci/staging.mjs';

const REPO = 'registry.lan.example:8443/little-moments';
const D = `sha256:${'d'.repeat(64)}`;
const P = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);
const SHA = 'e'.repeat(64);
const BACKUP_ID = 'staging-20260101T000000Z-eeeeeee';

const j = (o) => JSON.stringify(o);
const healthy10 = [{ t: 0, ok: true, durationMs: 12 }, { t: 10, ok: true, durationMs: 9 }, { t: 20, ok: true, durationMs: 11 }];

/** 與 deploy/bin/lm-deploy do_deploy 相同形狀的輸出（每行一個 JSON）。 */
function deployOutput({ results = healthy10, color = 'green', digest = D, upTo = 'switch', failure = null, receiptAi = undefined } = {}) {
  const lines = [];
  const add = (step, line) => { lines.push(j(line)); return step === upTo; };
  const stop = () => (failure ? [...lines, j({ ok: false, env: 'staging', ...failure })] : lines).join('\n') + '\n';
  if (add('backup', { ok: true, command: 'backup', id: BACKUP_ID, env: 'staging', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA, tables: 9, emptyDatabase: false, pruned: [] })) return stop();
  // deploy 的 app-env 結果行帶有寫入後的收據 AI 狀態（deploy/bin/lm-deploy emit_app_env；Components 第 25.4 節）。
  const appEnv = { ok: true, command: 'app-env', env: 'staging', keys: ['CAMPING_DATABASE_NAME'] };
  if (receiptAi !== undefined) appEnv.receiptAi = receiptAi;
  if (add('app-env', appEnv)) return stop();
  if (add('migrate', { ok: true, command: 'migrate', env: 'staging', digest, backupId: BACKUP_ID })) return stop();
  if (add('start', { ok: true, command: 'start', env: 'staging', color, digest, image: `${REPO}@${digest}` })) return stop();
  if (add('health', { ok: true, command: 'health', env: 'staging', color, healthy: true, results })) return stop();
  add('switch', { ok: true, command: 'switch', env: 'staging', from: { color: 'blue', digest: P }, to: { color, digest }, at: '2026-01-01T00:03:00+00:00' });
  return stop();
}

function statusLine({ phase = 'idle', active = { color: 'blue', digest: P }, candidate = null, previous = null } = {}) {
  return j({ ok: true, command: 'status', env: 'staging', phase, active, candidate, previous, history: [P], retained: [P], rollbackTargets: [], deployInProgress: false, lastBackup: null, backups: { count: 1, latest: null } }) + '\n';
}

const healthLine = (color, results = healthy10, ok = true) => j(ok
  ? { ok: true, command: 'health', env: 'staging', color, healthy: true, results }
  : { ok: false, command: 'health', env: 'staging', reason: 'health_failed', color, healthy: false, results }) + '\n';

const smokeText = (failStep = null) => j({
  ok: failStep === null,
  steps: ['login-page', 'session', 'login', 'trips', 'logout'].map((step) => ({
    step, status: step === failStep ? 500 : 200, ms: 20, result: step === failStep ? 'fail' : 'pass', ...(step === failStep ? { reason: 'status' } : {}),
  })),
}) + '\n';

describe('classifyDeploy（lm-deploy staging deploy 的判讀）', () => {
  test('備份、遷移、以 repo@digest 啟動、每 10 秒連續 3 次健康、切換 → switched（Req 14.1、18.1–18.3）', () => {
    const r = classifyDeploy(0, deployOutput(), D);
    expect(r.outcome).toBe('switched');
    expect(r.backup).toEqual({ id: BACKUP_ID, env: 'staging', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA });
    expect(r).toMatchObject({ migrated: true, started: true, color: 'green', healthy: true, cadenceOk: true, previous: { color: 'blue', digest: P } });
  });

  test('每 5 秒一次的健康檢查或輸出不完整時不視為成功（Req 18.3，fail closed）', () => {
    const fast = [{ t: 0, ok: true }, { t: 5, ok: true }, { t: 10, ok: true }];
    const r = classifyDeploy(0, deployOutput({ results: fast }), D);
    expect(r.outcome).toBe('unknown');
    expect(r.message).toContain('間隔小於 10 秒');
    expect(classifyDeploy(0, deployOutput({ upTo: 'health' }), D).outcome).toBe('unknown');
    // 執行中容器的 digest 必須與推送取得的完全相同（Req 18.1）。
    expect(classifyDeploy(0, deployOutput({ digest: P }), D).outcome).toBe('unknown');
  });

  test('備份失敗：記錄失敗原因類別、未遷移（Req 14.3）', () => {
    for (const [reason, kind] of [['backup_create_failed', 'create'], ['backup_verify_failed', 'verify'], ['backup_timeout', 'timeout']]) {
      const text = j({ ok: false, command: 'backup', env: 'staging', reason, message: 'x' }) + '\n';
      const r = classifyDeploy(1, text, D);
      expect(r).toMatchObject({ outcome: 'failed', failedStep: 'backup', backupFailure: kind, migrated: false, backup: null });
    }
  });

  test('遷移失敗不啟動新容器；啟動健康失敗與切換前失敗的步驟不同（Req 18.5、18.7）', () => {
    const mig = classifyDeploy(1, deployOutput({ upTo: 'app-env', failure: { command: 'migrate', reason: 'migrate_failed' } }), D);
    expect(mig).toMatchObject({ outcome: 'failed', failedStep: 'migrate', started: false });
    expect(mig.message).toContain('Req 18.7');
    const health = classifyDeploy(1, deployOutput({ upTo: 'start', failure: { command: 'health', reason: 'health_failed', results: [{ t: 0, ok: false }] } }), D);
    expect(health).toMatchObject({ outcome: 'failed', failedStep: 'health', started: true });
    const sw = classifyDeploy(1, deployOutput({ upTo: 'health', failure: { command: 'switch', reason: 'health_failed' } }), D);
    expect(sw).toMatchObject({ outcome: 'failed', failedStep: 'switch' });
  });

  test('鎖、未完成的部署、參數錯誤為 refused；SSH 中斷或逾時為 unknown', () => {
    expect(classifyDeploy(4, j({ ok: false, command: 'deploy', reason: 'locked' }), D).outcome).toBe('refused');
    expect(classifyDeploy(3, j({ ok: false, command: 'deploy', reason: 'invalid_phase' }), D).outcome).toBe('refused');
    expect(classifyDeploy(2, j({ ok: false, command: 'deploy', reason: 'invalid_digest' }), D).outcome).toBe('refused');
    expect(classifyDeploy(255, '', D).outcome).toBe('unknown');
    expect(classifyDeploy(124, deployOutput({ upTo: 'start' }), D).outcome).toBe('unknown');
  });
});

describe('rollbackNeeded / classifyRestore（Req 18.5、18.8）', () => {
  test('只回滾本次建置的部署；lm-deploy 拒絕時不回滾', () => {
    const switched = statusLine({ phase: 'switched', active: { color: 'green', digest: D }, previous: { color: 'blue', digest: P } });
    expect(rollbackNeeded({ outcome: 'unknown' }, switched, D).rollback).toBe(true);
    expect(rollbackNeeded({ outcome: 'refused' }, switched, D).rollback).toBe(false);
    expect(rollbackNeeded({ outcome: 'failed' }, statusLine(), D).rollback).toBe(false);
    expect(rollbackNeeded({ outcome: 'failed' }, statusLine({ phase: 'started', candidate: { color: 'green', digest: D } }), D).rollback).toBe(true);
    expect(rollbackNeeded({ outcome: 'failed' }, statusLine({ phase: 'started', candidate: { color: 'green', digest: P } }), D).rollback).toBe(false);
    expect(rollbackNeeded(null, 'garbage', D).rollback).toBe(true);
    expect(parseStatus(statusLine().replace('"staging"', '"prod"')).ok).toBe(false);
  });

  test('切回前一個已驗證版本並健康 → restored；無前一個版本 → 新容器已停止且無可還原者', () => {
    const restored = classifyRestore({ statusText: statusLine(), digest: D, rollbackAttempted: true, rollbackExit: 0, rollbackText: j({ ok: true, command: 'rollback' }), healthExit: 0, healthText: healthLine('blue') });
    expect(restored).toMatchObject({ restored: true, newStopped: true, target: P, code: 'restored' });
    const none = classifyRestore({ statusText: statusLine({ active: null }), digest: D, rollbackAttempted: true, rollbackExit: 0 });
    expect(none).toMatchObject({ restored: false, newStopped: true, noRestoreTarget: true, code: 'no_restore_target' });
    const running = classifyRestore({ statusText: statusLine({ phase: 'switched', active: { color: 'green', digest: D } }), digest: D });
    expect(running).toMatchObject({ restored: false, newStopped: false, code: 'new_container_running' });
    const unhealthy = classifyRestore({ statusText: statusLine(), digest: D, healthExit: 1, healthText: healthLine('blue', [{ t: 0, ok: false }], false) });
    expect(unhealthy).toMatchObject({ restored: false, code: 'restore_unhealthy' });
    // 健康檢查必須針對作用中的槽位。
    expect(classifyRestore({ statusText: statusLine(), digest: D, healthExit: 0, healthText: healthLine('green') }).restored).toBe(false);
  });
});

describe('Smoke_Test 與 Staging 驗證（Req 18.3、18.4）', () => {
  const deploy = classifyDeploy(0, deployOutput(), D);

  test('全部項目通過才算驗證通過；逾時或任一項目失敗即未通過', () => {
    expect(stagingVerdict({ deploy, smokeExit: 0, smokeText: smokeText() }).verified).toBe(true);
    const failed = stagingVerdict({ deploy, smokeExit: 1, smokeText: smokeText('trips') });
    expect(failed.verified).toBe(false);
    expect(failed.unmet.join()).toContain('trips');
    const timeout = stagingVerdict({ deploy, smokeExit: 124, smokeText: '' });
    expect(timeout.unmet).toContain('Smoke_Test 未於 10 分鐘內完成');
    expect(stagingVerdict({ deploy, smokeExit: 0, smokeText: '' }).verified).toBe(false);
    expect(stagingVerdict({ deploy: { ...deploy, outcome: 'failed', message: 'x' }, smokeExit: 0, smokeText: smokeText() }).verified).toBe(false);
  });

  test('Smoke_Test 結果只保留步驟名稱、狀態碼、耗時與結果', () => {
    const s = parseSmoke(0, j({ ok: true, steps: [{ step: 'login', status: 200, ms: 3.4, result: 'pass', body: 'secret-ish' }] }));
    expect(s.steps).toEqual([{ step: 'login', status: 200, ms: 3, result: 'pass' }]);
    expect(s.ok).toBe(false);
  });
});

describe('staging-verified predicate 與 attestation', () => {
  test('predicate 形狀與 ci/resolve-digest.mjs 的檢查一致（type、subject、commit、smoke）', () => {
    expect(STAGING_PREDICATE_TYPE).toBe(RESOLVE_TYPE);
    const predicate = buildPredicate({ commit: COMMIT, digest: D, build: 'release/little-moments/main#7', verifiedAt: '2026-01-01T00:05:00.000Z' });
    expect(predicate).toEqual({ commit: COMMIT, digest: D, env: 'staging', verifiedAt: '2026-01-01T00:05:00.000Z', build: 'release/little-moments/main#7', healthChecks: 3, smoke: 'pass' });
    const envelope = (p, type = STAGING_PREDICATE_TYPE, sha = D.slice(7)) => j({
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(j({ _type: 'https://in-toto.io/Statement/v0.1', predicateType: type, subject: [{ name: REPO, digest: { sha256: sha } }], predicate: p })).toString('base64'),
      signatures: [],
    });
    expect(checkStagingAttestation(envelope(predicate), { commit: COMMIT, digest: D })).toBe(true);
    expect(checkStagingAttestation(envelope({ ...predicate, commit: 'f'.repeat(40) }), { commit: COMMIT, digest: D })).toBe(false);
    expect(checkStagingAttestation(envelope(predicate, 'https://example.invalid/other'), { commit: COMMIT, digest: D })).toBe(false);
    expect(checkStagingAttestation(envelope(predicate, STAGING_PREDICATE_TYPE, 'f'.repeat(64)), { commit: COMMIT, digest: D })).toBe(false);
    expect(() => buildPredicate({ commit: COMMIT, digest: D, build: 'x', verifiedAt: '2026-01-01 00:00' })).toThrow();
  });
});

describe('stagingRecord：Build_Record 與「Staging」關卡（Req 14.8、18.4、18.8、23.5）', () => {
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 7, url: 'https://jenkins.invalid/job/7/',
    commit: COMMIT, trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });
  const deploy = classifyDeploy(0, deployOutput(), D);
  const verdict = stagingVerdict({ deploy, smokeExit: 0, smokeText: smokeText() });

  test('通過：記錄 digest、commit、驗證完成時間、備份資訊與 Health_Check 結果', () => {
    const { patch, gate } = stagingRecord({ commit: COMMIT, digest: D, deploy, verdict, signature: 'ok', finalize: 'ok', attestation: 'ok', at: '2026-01-01T00:06:00.000Z', reports: ['reports/staging/deploy.jsonl'] });
    expect(gate).toMatchObject({ gate: 'Staging', pass: true, status: 'pass', commit: COMMIT, unmet: [] });
    expect(patch.backup).toEqual({ id: BACKUP_ID, env: 'staging', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA });
    expect(patch.deployments[0]).toMatchObject({ env: 'staging', digest: D, commit: COMMIT, result: 'staging_verified', stagingVerified: true, verifiedAt: '2026-01-01T00:06:00.000Z', healthChecks: healthy10 });
    expect(patch.rollback).toBeUndefined();
    const rec = addGateResult(mergeRecord(base(), patch), gate);
    expect(validateRecord(rec).ok).toBe(true);
    expect(rec.gates.at(-1)).toMatchObject({ gate: 'Staging', pass: true });
  });

  test('驗證失敗且無可還原者：關卡未通過、記錄無可還原的 Image_Digest 與自動回滾（Req 18.8）', () => {
    const failedVerdict = stagingVerdict({ deploy, smokeExit: 1, smokeText: smokeText('login') });
    const restore = classifyRestore({ statusText: statusLine({ active: null }), digest: D, rollbackAttempted: true, rollbackExit: 0 });
    const { patch, gate } = stagingRecord({ commit: COMMIT, digest: D, deploy, verdict: failedVerdict, restore, signature: 'ok' });
    expect(gate.pass).toBe(false);
    expect(gate.unmet.join()).toContain('Req 18.8');
    expect(patch.deployments[0]).toMatchObject({ result: 'no_restore_target', stagingVerified: false, restore: { noRestoreTarget: true, newStopped: true } });
    expect(patch.deployments[0].verifiedAt).toBeUndefined();
    expect(patch.rollback).toMatchObject({ trigger: 'auto', from: D, to: '不適用' });
    expect(validateRecord(addGateResult(mergeRecord(base(), patch), gate)).ok).toBe(true);
  });

  test('簽章驗證失敗時未部署；階段錯誤時關卡狀態為 error（Req 17.8、23.3）', () => {
    expect(stagingRecord({ commit: COMMIT, digest: D, signature: 'fail' })).toMatchObject({ gate: { pass: false, status: 'fail' }, patch: { deployments: [{ result: 'signature_failed' }] } });
    expect(stagingRecord({ commit: COMMIT, digest: D, deploy, verdict, signature: 'ok', finalize: 'ok', attestation: 'ok', stageError: '逾時' }).gate.status).toBe('error');
    expect(() => stagingRecord({ commit: COMMIT, digest: D, signature: 'yes' })).toThrow();
  });

  test('收據 AI：app-env 結果行的 receiptAi 寫入 deployments[].receiptAi；缺少或其他值為「未執行」（Components 第 25.3 節）', () => {
    // Staging 由 lm-deploy 固定為 disabled；判讀只接受 enabled／disabled，與 Production 相同。
    const cases = [['disabled', 'disabled'], ['enabled', 'enabled'], [undefined, '未執行'], ['off', '未執行'], [false, '未執行']];
    for (const [value, expected] of cases) {
      const d = classifyDeploy(0, deployOutput({ receiptAi: value }), D);
      expect(d.outcome).toBe('switched');
      expect(d.receiptAi).toBe(expected === '未執行' ? null : expected);
      const v = stagingVerdict({ deploy: d, smokeExit: 0, smokeText: smokeText() });
      const { patch, gate } = stagingRecord({ commit: COMMIT, digest: D, deploy: d, verdict: v, signature: 'ok', finalize: 'ok', attestation: 'ok' });
      expect(patch.deployments[0].receiptAi).toBe(expected);
      expect(gate.pass).toBe(true);
      expect(validateRecord(addGateResult(mergeRecord(base(), patch), gate)).ok).toBe(true);
    }
    // lm-deploy 在備份前拒絕（receipt_ai_forbidden，沒有 app-env 結果行）與未部署：「未執行」。
    const refused = classifyDeploy(2, j({ ok: false, command: 'deploy', env: 'staging', reason: 'receipt_ai_forbidden' }) + '\n', D);
    expect(refused).toMatchObject({ outcome: 'refused', receiptAi: null });
    expect(stagingRecord({ commit: COMMIT, digest: D, deploy: refused, signature: 'ok' }).patch.deployments[0].receiptAi).toBe('未執行');
    const none = stagingRecord({ commit: COMMIT, digest: D, signature: 'fail' });
    expect(none.patch.deployments[0].receiptAi).toBe('未執行');
    expect(validateRecord(mergeRecord(base(), none.patch)).ok).toBe(true);
  });
});

describe('CLI（Jenkinsfile 使用的檔名與參數）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-staging-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, error: () => {} };
  const f = (n) => join(dir, n);

  test('classify → verdict → record：通過時寫出 predicate、Build_Record patch 與「Staging」關卡', () => {
    writeFileSync(f('deploy.jsonl'), deployOutput());
    writeFileSync(f('smoke.json'), smokeText());
    expect(main(['classify', '--exit', '0', '--result', f('deploy.jsonl'), '--digest', D, '--out', f('deploy-verdict.json')], quiet)).toBe(0);
    const now = () => new Date('2026-01-01T00:05:00.000Z');
    expect(main(['verdict', '--deploy', f('deploy-verdict.json'), '--smoke', f('smoke.json'), '--smoke-exit', '0', '--commit', COMMIT, '--digest', D,
      '--build', 'release/little-moments/main#7', '--out', f('verdict.json'), '--out-predicate', f('predicate.json')], { ...quiet, now })).toBe(0);
    expect(JSON.parse(readFileSync(f('predicate.json'), 'utf8'))).toMatchObject({ commit: COMMIT, smoke: 'pass', verifiedAt: '2026-01-01T00:05:00.000Z' });
    expect(main(['record', '--dir', dir, '--commit', COMMIT, '--digest', D, '--signature', 'ok', '--finalize', 'ok', '--attestation', 'ok',
      '--out-patch', f('patch.json'), '--out-gate', f('gate.json')], quiet)).toBe(0);
    const patch = JSON.parse(readFileSync(f('patch.json'), 'utf8'));
    expect(Object.keys(patch.reports).sort()).toEqual(['stagingDeploy', 'stagingSmoke', 'stagingVerdict']);
    expect(JSON.parse(readFileSync(f('gate.json'), 'utf8')).pass).toBe(true);
    // attestation 未完成 → 關卡未通過（結束碼 1）。
    expect(main(['record', '--dir', dir, '--commit', COMMIT, '--digest', D, '--signature', 'ok', '--finalize', 'ok', '--attestation', 'fail',
      '--out-patch', f('patch.json'), '--out-gate', f('gate.json')], quiet)).toBe(1);
  });

  test('Smoke_Test 失敗時不寫 predicate；restore／rollback-needed／active 的結束碼', () => {
    writeFileSync(f('smoke-fail.json'), smokeText('session'));
    rmSync(f('predicate-2.json'), { force: true });
    expect(main(['verdict', '--deploy', f('deploy-verdict.json'), '--smoke', f('smoke-fail.json'), '--smoke-exit', '1', '--commit', COMMIT, '--digest', D,
      '--build', 'b#1', '--out', f('verdict-2.json'), '--out-predicate', f('predicate-2.json')], quiet)).toBe(1);
    expect(existsSync(f('predicate-2.json'))).toBe(false);
    writeFileSync(f('status.json'), statusLine({ phase: 'switched', active: { color: 'green', digest: D }, previous: { color: 'blue', digest: P } }));
    expect(main(['rollback-needed', '--deploy', f('deploy-verdict.json'), '--status', f('status.json'), '--digest', D], quiet)).toBe(0);
    writeFileSync(f('status-after.json'), statusLine());
    writeFileSync(f('health.jsonl'), healthLine('blue'));
    expect(main(['active', '--status', f('status-after.json')], quiet)).toBe(0);
    expect(main(['restore', '--status', f('status-after.json'), '--digest', D, '--rollback', f('none.jsonl'), '--rollback-exit', '0',
      '--health', f('health.jsonl'), '--health-exit', '0', '--out', f('restore.json')], quiet)).toBe(0);
    expect(main(['restore', '--status', f('status-after.json'), '--digest', D, '--rollback', f('none.jsonl'), '--rollback-exit', '-1',
      '--health', f('health.jsonl'), '--health-exit', '1', '--out', f('restore-2.json')], quiet)).toBe(1);
    expect(main(['classify', '--exit', 'x', '--result', f('deploy.jsonl'), '--digest', D, '--out', f('x.json')], quiet)).toBe(2);
  });
});

describe('性質', () => {
  const resultArb = fc.array(fc.record({ t: fc.integer({ min: 0, max: 130 }), ok: fc.boolean(), durationMs: fc.integer({ min: 0, max: 6000 }) }), { minLength: 1, maxLength: 14 })
    .map((rs) => [...rs].sort((a, b) => a.t - b.t));

  // Property 40（Staging 套用）：部署判定為 switched 若且唯若啟動健康檢查在 120 秒內連續 3 次成功，且相鄰兩次至少間隔 10 秒。
  // **Validates: Requirements 18.3, 18.5**
  test('Property 40（Staging）：switched ⇔ healthyWithin(results, 120, 3) ∧ 每次間隔 ≥ 10 秒', () => {
    fc.assert(fc.property(resultArb, (results) => {
      const r = classifyDeploy(0, deployOutput({ results }), D);
      const expected = healthyWithin(results, 120, 3) && healthCadenceOk(results, 10);
      expect(r.outcome === 'switched').toBe(expected);
    }), { numRuns: 300 });
  });

  // Property 45（Staging 關卡 fail closed）：「Staging」關卡通過若且唯若簽章驗證、Staging 驗證、finalize、attestation 皆完成且無階段錯誤。
  // **Validates: Requirements 18.4, 18.5, 23.2, 23.3**
  test('Property 45（Staging）：關卡通過 ⇔ 所有條件成立；未通過時一定列出未符合的條件', () => {
    const deployOk = classifyDeploy(0, deployOutput(), D);
    const fact = fc.constantFrom('ok', 'fail', 'not_run');
    fc.assert(fc.property(fact, fact, fact, fc.boolean(), fc.boolean(), fc.option(fc.constantFrom('逾時', '中止'), { nil: null }),
      (signature, finalize, attestation, switched, smokeOk, stageError) => {
        const deploy = switched ? deployOk : { ...deployOk, outcome: 'failed', message: '部署失敗' };
        const verdict = stagingVerdict({ deploy, smokeExit: smokeOk ? 0 : 1, smokeText: smokeText(smokeOk ? null : 'trips') });
        const { gate, patch } = stagingRecord({ commit: COMMIT, digest: D, deploy, verdict, signature, finalize, attestation, stageError });
        const expected = signature === 'ok' && switched && smokeOk && finalize === 'ok' && attestation === 'ok' && stageError === null;
        expect(gate.pass).toBe(expected);
        expect(patch.deployments[0].stagingVerified).toBe(expected);
        expect(gate.pass || gate.unmet.length > 0).toBe(true);
        expect(validateRecord(patch).ok).toBe(true);
      }), { numRuns: 300 });
  });
});
