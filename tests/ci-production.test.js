// ci/production.mjs：Release_Tag 的正式核准與 Production 部署判讀
// （Req 12.6、14.1–14.3、19.2–19.8、20.1–20.7、20.9、20.11、22.5、23.1–23.3、23.5；
//  Property 40 的 Production 觀察期套用、Property 45 的 fail closed）。
import { afterAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addGateResult, createRecord, mergeRecord, validateRecord } from '../ci/record.mjs';
import { STAGING_PREDICATE_TYPE } from '../ci/resolve-digest.mjs';
import {
  OBSERVATION_CHECKS, approvalMessage, approvalRecord, classifyDeploy, classifyRestore, deployedCommit, healthObservation,
  main, observationDecision, observationSummary, parseTagRemote, pendingDestructive, productionRecord, rollbackNeeded,
  rollbackSummary, smokeObservation, stagingEvidence,
} from '../ci/production.mjs';

const REPO = 'registry.lan.example:8443/little-moments';
const D = `sha256:${'d'.repeat(64)}`;
const P = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);
const OTHER = 'f'.repeat(40);
const SHA = 'e'.repeat(64);
const BACKUP_ID = 'prod-20260101T000000Z-eeeeeee';
const TAG = 'v1.2.3';
const j = (o) => JSON.stringify(o);
const healthy5 = [{ t: 0, ok: true, durationMs: 12 }, { t: 5, ok: true, durationMs: 9 }, { t: 10, ok: true, durationMs: 11 }];

const tmp = mkdtempSync(join(tmpdir(), 'lm-production-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 與 deploy/bin/lm-deploy do_deploy 相同形狀的輸出（每行一個 JSON）。 */
function deployOutput({ results = healthy5, color = 'green', digest = D, upTo = 'switch', failure = null, receiptAi = undefined } = {}) {
  const lines = [];
  const add = (step, line) => { lines.push(j(line)); return step === upTo; };
  const stop = () => (failure ? [...lines, j({ ok: false, env: 'prod', ...failure })] : lines).join('\n') + '\n';
  if (add('backup', { ok: true, command: 'backup', id: BACKUP_ID, env: 'prod', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA, tables: 9, emptyDatabase: false, pruned: [] })) return stop();
  // deploy 的 app-env 結果行帶有寫入後的收據 AI 狀態（deploy/bin/lm-deploy emit_app_env；Components 第 25.4 節）。
  const appEnv = { ok: true, command: 'app-env', env: 'prod', keys: ['CAMPING_DATABASE_NAME'] };
  if (receiptAi !== undefined) appEnv.receiptAi = receiptAi;
  if (add('app-env', appEnv)) return stop();
  if (add('migrate', { ok: true, command: 'migrate', env: 'prod', digest, backupId: BACKUP_ID })) return stop();
  if (add('start', { ok: true, command: 'start', env: 'prod', color, digest, image: `${REPO}@${digest}` })) return stop();
  if (add('health', { ok: true, command: 'health', env: 'prod', color, healthy: true, results })) return stop();
  add('switch', { ok: true, command: 'switch', env: 'prod', from: { color: 'blue', digest: P }, to: { color, digest }, at: '2026-01-01T00:03:00+00:00' });
  return stop();
}

function statusLine({ phase = 'idle', active = { color: 'blue', digest: P }, candidate = null, previous = null } = {}) {
  return j({
    ok: true, command: 'status', env: 'prod', phase, active, candidate, previous, history: [P], retained: [P], rollbackTargets: [],
    deployInProgress: false, lastBackup: null, backups: { count: 1, latest: null },
  }) + '\n';
}

const healthOnce = (color, ok = true, durationMs = 20) => j(ok
  ? { ok: true, command: 'health', env: 'prod', color, healthy: true, at: '2026-01-01T00:04:00+00:00', durationMs }
  : { ok: false, command: 'health', env: 'prod', reason: 'health_failed', color, healthy: false, at: '2026-01-01T00:04:00+00:00', durationMs }) + '\n';
const healthWait = (color, ok = true) => j(ok
  ? { ok: true, command: 'health', env: 'prod', color, healthy: true, results: healthy5 }
  : { ok: false, command: 'health', env: 'prod', reason: 'health_failed', color, healthy: false, results: [{ t: 0, ok: false, durationMs: 5000 }] }) + '\n';
const smokeText = (failStep = null) => j({
  ok: failStep === null,
  steps: ['login-page', 'session', 'login', 'trips', 'logout'].map((step) => ({
    step, status: step === failStep ? 500 : 200, ms: 20, result: step === failStep ? 'fail' : 'pass',
  })),
}) + '\n';

/** 完整、全部通過的觀察期：每 10 秒一次 Health_Check（共 60 次）、第 1 次與第 55 次後各一次 Smoke_Test。 */
function fullObservation({ healthFail = new Set(), smokeFail = new Set() } = {}) {
  const obs = [];
  for (let i = 0; i < OBSERVATION_CHECKS; i++) {
    obs.push({ type: 'health', t: i * 10, ok: !healthFail.has(i), durationMs: 15 });
    if (i === 0) obs.push({ type: 'smoke', t: 1, ok: !smokeFail.has('after-switch'), phase: 'after-switch', failedSteps: [] });
    if (i === 54) obs.push({ type: 'smoke', t: 541, ok: !smokeFail.has('before-end'), phase: 'before-end', failedSteps: [] });
  }
  return obs;
}

describe('classifyDeploy（lm-deploy prod deploy 的判讀）', () => {
  test('備份、遷移、以 repo@digest 啟動、每 5 秒連續 3 次健康、切換 → switched（Req 14.1、20.1–20.3）', () => {
    const r = classifyDeploy(0, deployOutput(), D);
    expect(r.outcome).toBe('switched');
    expect(r.backup).toEqual({ id: BACKUP_ID, env: 'prod', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA });
    expect(r.color).toBe('green');
    expect(r.previous).toEqual({ color: 'blue', digest: P });
    expect(r.health).toEqual(healthy5);
  });

  test('結束碼 0 但新容器的 digest 不同或間隔小於 5 秒 → unknown（不信任輸出）', () => {
    expect(classifyDeploy(0, deployOutput({ digest: P }), D).outcome).toBe('unknown');
    const fast = [{ t: 0, ok: true }, { t: 2, ok: true }, { t: 4, ok: true }];
    expect(classifyDeploy(0, deployOutput({ results: fast }), D).outcome).toBe('unknown');
  });

  test('啟動健康失敗：新容器已移除、reverse proxy 未變更，保留各次 Health_Check 結果（Req 20.4）', () => {
    const results = [{ t: 0, ok: false, durationMs: 5000 }, { t: 5, ok: false, durationMs: 5000 }];
    const text = deployOutput({ upTo: 'start', failure: { command: 'health', reason: 'health_failed', healthy: false, results } });
    const r = classifyDeploy(1, text, D);
    expect(r.outcome).toBe('failed');
    expect(r.failedStep).toBe('health');
    expect(r.health).toEqual(results);
    expect(r.message).toContain('reverse proxy 未變更');
  });

  test('備份失敗不執行遷移；鎖已被持有與未完成的部署為 refused（Req 14.3、20.12）', () => {
    const r = classifyDeploy(1, j({ ok: false, command: 'backup', env: 'prod', reason: 'backup_verify_failed' }), D);
    expect(r).toMatchObject({ outcome: 'failed', failedStep: 'backup', backupFailure: 'verify', migrated: false });
    expect(classifyDeploy(4, j({ ok: false, reason: 'deploy_in_progress' }), D).outcome).toBe('refused');
    expect(classifyDeploy(3, j({ ok: false, reason: 'invalid_phase' }), D).outcome).toBe('refused');
    expect(classifyDeploy(255, '', D).outcome).toBe('unknown');
  });
});

describe('觀察期（Req 20.5、20.6）', () => {
  test('單次 Health_Check：結束碼 0、healthy、槽位相符且 5 秒內 → 成功', () => {
    expect(healthObservation(0, healthOnce('green'), 10, 'green')).toEqual({ type: 'health', t: 10, ok: true, durationMs: 20 });
    expect(healthObservation(0, healthOnce('blue'), 10, 'green').ok).toBe(false);
    expect(healthObservation(1, healthOnce('green', false), 10, 'green').ok).toBe(false);
    expect(healthObservation(0, healthOnce('green', true, 5001), 10, 'green').ok).toBe(false);
    expect(healthObservation(255, '', 10, 'green').ok).toBe(false);
  });

  test('Smoke_Test 觀察結果只保留未通過的步驟名稱（Req 21.10）', () => {
    expect(smokeObservation(0, smokeText(), 1, 'after-switch')).toMatchObject({ type: 'smoke', ok: true, failedSteps: [] });
    expect(smokeObservation(1, smokeText('trips'), 541, 'before-end')).toMatchObject({ ok: false, failedSteps: ['trips'] });
    expect(smokeObservation(124, '', 541, 'before-end')).toMatchObject({ ok: false, timedOut: true });
  });

  test('完整且全部通過的觀察期：不回滾、summary complete', () => {
    const d = observationDecision(fullObservation());
    expect(d.rollback).toBe(false);
    expect(d.summary).toMatchObject({ healthChecks: 60, healthFailures: 0, complete: true, unmet: [] });
  });

  test('連續 3 次 Health_Check 失敗 → 回滾，原因含失敗時間點；不連續的失敗不回滾', () => {
    const d = observationDecision(fullObservation({ healthFail: new Set([10, 11, 12]) }));
    expect(d.rollback).toBe(true);
    expect(d.trigger.reason).toBe('health_consecutive_failures');
    expect(d.reason).toBe('Health_Check 連續 3 次失敗（切換後 100、110、120 秒）');
    expect(observationDecision(fullObservation({ healthFail: new Set([10, 11, 13, 14]) })).rollback).toBe(false);
  });

  test('任一次 Smoke_Test 失敗 → 回滾；缺少 Smoke_Test 或次數不足 → 未完整（「上線後」未通過）', () => {
    expect(observationDecision(fullObservation({ smokeFail: new Set(['before-end']) })).reason).toContain('Smoke_Test 失敗');
    const noEnd = fullObservation().filter((o) => o.phase !== 'before-end');
    expect(observationSummary(noEnd).unmet).toContain('觀察期結束前 60 秒內未執行 Smoke_Test');
    const short = fullObservation().slice(0, 30);
    expect(observationSummary(short).complete).toBe(false);
    const lateSmoke = fullObservation().map((o) => (o.phase === 'after-switch' ? { ...o, t: 61 } : o));
    expect(observationSummary(lateSmoke).unmet).toContain('切換後 60 秒內未執行 Smoke_Test');
  });
});

describe('回滾與還原（Req 20.4、20.6、20.9、20.11）', () => {
  test('rollbackNeeded：拒絕的部署不回滾；部署停在 switched 或 started 時回滾；idle 不回滾', () => {
    expect(rollbackNeeded({ outcome: 'refused' }, statusLine({ phase: 'switched', active: { color: 'green', digest: D } }), D).rollback).toBe(false);
    expect(rollbackNeeded(null, statusLine({ phase: 'switched', active: { color: 'green', digest: D }, previous: { color: 'blue', digest: P } }), D).rollback).toBe(true);
    expect(rollbackNeeded(null, statusLine({ phase: 'started', candidate: { color: 'green', digest: D } }), D).rollback).toBe(true);
    expect(rollbackNeeded(null, statusLine(), D).rollback).toBe(false);
    expect(rollbackNeeded(null, 'garbage', D).rollback).toBe(true);
  });

  test('已切回舊槽位且 120 秒內連續 3 次健康 → restored；不健康 → 需人工介入，不再自動切換', () => {
    const rb = j({ ok: true, command: 'rollback', env: 'prod', mode: 'auto', from: { color: 'green', digest: D }, to: { color: 'blue', digest: P }, restored: true, migrationsRun: false });
    const base = { statusText: statusLine(), digest: D, rollbackAttempted: true, rollbackExit: 0, rollbackText: rb };
    const ok = classifyRestore({ ...base, healthExit: 0, healthText: healthWait('blue') });
    expect(ok).toMatchObject({ restored: true, target: P, manualIntervention: false, code: 'restored' });
    expect(ok.rollback).toEqual({ attempted: true, ok: true, code: 'rolled_back' });
    const bad = classifyRestore({ ...base, healthExit: 1, healthText: healthWait('blue', false) });
    expect(bad).toMatchObject({ restored: false, manualIntervention: true, code: 'restore_unhealthy' });
    expect(classifyRestore({ ...base, healthExit: 0, healthText: healthWait('green') }).restored).toBe(false);
  });

  test('切換前失敗（未回滾）：舊版持續服務且健康 → restored，訊息說明未切換；沒有前一個版本 → 需人工介入', () => {
    const r = classifyRestore({ statusText: statusLine(), digest: D, healthExit: 0, healthText: healthWait('blue') });
    expect(r.restored).toBe(true);
    expect(r.message).toContain('未切換');
    const none = classifyRestore({ statusText: statusLine({ active: null }), digest: D });
    expect(none).toMatchObject({ restored: false, noRestoreTarget: true, code: 'no_restore_target' });
    const running = classifyRestore({ statusText: statusLine({ phase: 'switched', active: { color: 'green', digest: D } }), digest: D });
    expect(running.code).toBe('new_container_running');
  });
});

describe('productionRecord：Build_Record 與「上線後」關卡（Req 14.8、20.7、20.9、22.5、23.5）', () => {
  const tagRecord = () => createRecord({
    job: 'release/little-moments/v1.2.3', number: 4, url: 'https://jenkins.invalid/job/4/',
    commit: COMMIT, trigger: 'release_tag', ref: TAG, buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });
  const deploy = classifyDeploy(0, deployOutput(), D);

  test('切換、觀察期完整、finalize 完成 → 通過；patch 可合併進 Release_Tag 的 Build_Record', () => {
    const { patch, gate } = productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy, observations: fullObservation(), signature: 'ok', finalize: 'ok', at: '2026-01-01T00:14:00.000Z' });
    expect(gate).toMatchObject({ gate: '上線後', pass: true, status: 'pass', commit: COMMIT, unmet: [] });
    expect(patch.deployments[0]).toMatchObject({ env: 'production', digest: D, tag: TAG, result: 'released', backupId: BACKUP_ID, migrationsRun: true, finalize: 'ok' });
    expect(patch.deployments[0].observation).toMatchObject({ healthChecks: 60, complete: true, rollbackTriggered: false });
    expect(patch.backup).toEqual({ id: BACKUP_ID, env: 'prod', createdAt: '2026-01-01T00:00:00+00:00', sizeBytes: 4096, sha256: SHA });
    expect(patch.rollback).toBeUndefined();
    const rec = addGateResult(mergeRecord(tagRecord(), patch), gate);
    expect(validateRecord(rec).ok).toBe(true);
  });

  test('觀察期觸發回滾：rollback 區段記錄 auto、來源與目標 digest、原因；建置摘要含原因與前後 digest（Req 20.9、22.5）', () => {
    const obs = fullObservation({ healthFail: new Set([3, 4, 5]) }).slice(0, 7);
    const rb = j({ ok: true, command: 'rollback', env: 'prod', mode: 'auto', from: { color: 'green', digest: D }, to: { color: 'blue', digest: P }, restored: true, migrationsRun: false });
    const restore = classifyRestore({ statusText: statusLine(), digest: D, rollbackAttempted: true, rollbackExit: 0, rollbackText: rb, healthExit: 0, healthText: healthWait('blue') });
    const { patch, gate } = productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy, observations: obs, restore, signature: 'ok', at: '2026-01-01T00:05:00.000Z' });
    expect(gate.pass).toBe(false);
    expect(gate.unmet).toContain('Health_Check 連續 3 次失敗');
    expect(patch.rollback).toEqual({ trigger: 'auto', by: 'pipeline', from: D, to: P, reason: 'Health_Check 連續 3 次失敗（切換後 30、40、50 秒）', at: '2026-01-01T00:05:00.000Z' });
    expect(patch.deployments[0]).toMatchObject({ result: 'rolled_back', manualInterventionRequired: false });
    expect(validateRecord(mergeRecord(tagRecord(), patch)).ok).toBe(true);
    const summary = rollbackSummary({ digest: D, restore, reason: patch.rollback.reason });
    expect(summary).toContain('Health_Check 連續 3 次失敗');
    expect(summary).toContain(D.slice(0, 19));
    expect(summary).toContain(P.slice(0, 19));
  });

  test('簽章未通過、部署被拒絕、階段錯誤或缺少 finalize 一律未通過（fail closed）', () => {
    expect(productionRecord({ commit: COMMIT, digest: D, tag: TAG, signature: 'fail' }).gate.unmet[0]).toContain('簽章');
    const refused = classifyDeploy(4, '', D);
    expect(productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy: refused, signature: 'ok' }).patch.deployments[0].result).toBe('refused');
    const err = productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy, observations: fullObservation(), signature: 'ok', finalize: 'ok', stageError: '觀察期逾時或被中止' });
    expect(err.gate).toMatchObject({ pass: false, status: 'error' });
    expect(productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy, observations: fullObservation(), signature: 'ok', finalize: 'fail' }).gate.unmet).toContain('lm-deploy prod finalize 未完成');
  });

  test('收據 AI：app-env 結果行的 receiptAi 寫入 deployments[].receiptAi；缺少或其他值為「未執行」（Components 第 25.3 節）', () => {
    const cases = [['enabled', 'enabled'], ['disabled', 'disabled'], [undefined, '未執行'], ['on', '未執行'], [true, '未執行'], ['ENABLED', '未執行']];
    for (const [value, expected] of cases) {
      const d = classifyDeploy(0, deployOutput({ receiptAi: value }), D);
      expect(d.outcome).toBe('switched');
      expect(d.receiptAi).toBe(expected === '未執行' ? null : expected);
      const { patch, gate } = productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy: d, observations: fullObservation(), signature: 'ok', finalize: 'ok' });
      expect(patch.deployments[0].receiptAi).toBe(expected);
      expect(gate.pass).toBe(true);
      expect(validateRecord(addGateResult(mergeRecord(tagRecord(), patch), gate)).ok).toBe(true);
    }
    // 備份前就失敗（沒有 app-env 結果行）、沒有部署：「未執行」。
    const early = classifyDeploy(1, j({ ok: false, command: 'backup', env: 'prod', reason: 'backup_create_failed' }) + '\n', D);
    expect(early.outcome).toBe('failed');
    expect(early.receiptAi).toBeNull();
    expect(productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy: early, signature: 'ok' }).patch.deployments[0].receiptAi).toBe('未執行');
    const none = productionRecord({ commit: COMMIT, digest: D, tag: TAG, signature: 'fail' });
    expect(none.patch.deployments[0].receiptAi).toBe('未執行');
    expect(validateRecord(mergeRecord(tagRecord(), none.patch)).ok).toBe(true);
    // 失敗的 app-env 行（ok:false）不算寫入後的狀態。
    const bad = classifyDeploy(2, j({ ok: false, command: 'app-env', env: 'prod', reason: 'app_env_invalid', receiptAi: 'enabled' }) + '\n', D);
    expect(bad.receiptAi).toBeNull();
  });
});

describe('破壞性遷移、Tag 與 Production 目前版本（Req 12.6、19.8）', () => {
  const safe = 'CREATE TABLE t (id INTEGER);\n';
  const marked = '-- lm:destructive\nALTER TABLE t DROP COLUMN x;\n';
  const unmarked = 'ALTER TABLE t DROP COLUMN y;\n';
  const files = [
    { name: '0001_initial.sql', content: safe },
    { name: '0002_drop_x.sql', content: marked },
    { name: '0003_drop_y.sql', content: unmarked },
    { name: '0004_add.sql', content: safe },
  ];

  test('只列出 Production 目前版本沒有的破壞性遷移；未標記但含破壞性語句者同樣需要核准', () => {
    expect(pendingDestructive(files, ['migrations/0001_initial.sql'])).toEqual([
      { version: 2, migration: 'migrations/0002_drop_x.sql' }, { version: 3, migration: 'migrations/0003_drop_y.sql' },
    ]);
    expect(pendingDestructive(files, ['migrations/0001_initial.sql', 'migrations/0002_drop_x.sql'])).toEqual([{ version: 3, migration: 'migrations/0003_drop_y.sql' }]);
    expect(pendingDestructive(files, files.map((f) => `migrations/${f.name}`))).toEqual([]);
  });

  test('無法判定 Production 目前版本時，所有破壞性遷移都需核准（fail closed）', () => {
    expect(pendingDestructive(files, null).map((p) => p.version)).toEqual([2, 3]);
  });

  test('parseTagRemote：lightweight 與 annotated（取 peeled 值）；格式不符或其他 ref 為 null', () => {
    expect(parseTagRemote(`${COMMIT}\trefs/tags/${TAG}\n`, TAG)).toBe(COMMIT);
    expect(parseTagRemote(`${OTHER}\trefs/tags/${TAG}\n${COMMIT}\trefs/tags/${TAG}^{}\n`, TAG)).toBe(COMMIT);
    expect(parseTagRemote('', TAG)).toBeNull();
    expect(parseTagRemote(`${COMMIT}\trefs/tags/v9.9.9\n`, TAG)).toBeNull();
    expect(parseTagRemote('fatal: could not read', TAG)).toBeNull();
    expect(parseTagRemote(`${COMMIT}\trefs/tags/${TAG}\n`, 'release-1')).toBeNull();
  });

  test('deployedCommit：作用中 digest 與 OCI revision 標籤', () => {
    const config = j({ config: { Labels: { 'org.opencontainers.image.revision': OTHER } } });
    expect(deployedCommit(statusLine(), config)).toEqual({ statusOk: true, digest: P, commit: OTHER });
    expect(deployedCommit(statusLine({ active: null }), config).commit).toBeNull();
    expect(deployedCommit(statusLine(), '{}').commit).toBeNull();
    expect(deployedCommit('garbage', config)).toEqual({ statusOk: false, digest: null, commit: null });
  });
});

describe('核准畫面與「正式核准」關卡（Req 19.2–19.8、12.6）', () => {
  const attestation = (predicate) => j({
    payload: Buffer.from(j({ predicateType: STAGING_PREDICATE_TYPE, subject: [{ digest: { sha256: D.slice(7) } }], predicate })).toString('base64'),
  }) + '\n';
  const mainRecord = {
    build: { job: 'release/little-moments/main', number: 41 },
    deployments: [{
      env: 'staging', digest: D, stagingVerified: true, verifiedAt: '2026-01-01T00:10:00.000Z',
      healthChecks: [{ t: 0, ok: true }, { t: 10, ok: true }, { t: 20, ok: true }],
      smoke: { ok: true, steps: ['login-page', 'session', 'login', 'trips', 'logout'].map((step) => ({ step, result: 'pass' })) },
    }],
  };

  test('核准畫面含 Tag、完整 SHA、完整 digest、Staging 健康與 smoke 結果與完成時間、安全報告連結', () => {
    const staging = stagingEvidence({ mainRecord, attestationText: attestation({ commit: COMMIT, smoke: 'pass', healthChecks: 3, verifiedAt: '2026-01-01T00:10:01.000Z' }), commit: COMMIT, digest: D });
    expect(staging).toMatchObject({ verified: true, verifiedAt: '2026-01-01T00:10:00.000Z', healthChecks: { total: 3, passed: 3 }, smoke: { ok: true, passed: 5, total: 5 } });
    const text = approvalMessage({
      tag: TAG, commit: COMMIT, digest: D, staging,
      links: ['https://jenkins.invalid/job/4/artifact/reports/gate-security.json', 'javascript:alert(1)'],
      destructive: [{ version: 2, migration: 'migrations/0002_drop_x.sql' }],
    });
    for (const s of [TAG, COMMIT, D, '3/3 次成功', '通過（5/5 項）', '2026-01-01T00:10:00.000Z', 'release/little-moments/main#41', 'https://jenkins.invalid/job/4/artifact/reports/gate-security.json', '破壞性遷移']) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('javascript:');
  });

  test('沒有 main Build_Record 時以 attestation 補充；兩者皆無時顯示無紀錄', () => {
    const fromAtt = stagingEvidence({ mainRecord: null, attestationText: attestation({ commit: COMMIT, smoke: 'pass', healthChecks: 3, verifiedAt: '2026-01-01T00:10:01.000Z' }), commit: COMMIT, digest: D });
    expect(fromAtt).toMatchObject({ verified: true, verifiedAt: '2026-01-01T00:10:01.000Z', healthChecksAttested: 3, smokeAttested: 'pass' });
    expect(stagingEvidence({ mainRecord: null, attestationText: attestation({ commit: OTHER, smoke: 'pass' }), commit: COMMIT, digest: D }).verified).toBe(false);
  });

  const at = '2026-01-02T09:00:00+08:00';
  const base = { tag: TAG, commit: COMMIT, digest: D, attempts: [], destructive: [], pendingDestructive: [] };

  test('核准：記錄核准人、含時區的時間與 digest，並記錄不生效的嘗試（Req 19.3、19.6）', () => {
    const attempts = [{ id: 'mallory', at, action: 'approve' }, { id: 'bad id\n', at: 'x', action: 'whatever' }];
    const { patch, gate, evidence } = approvalRecord({ ...base, decision: 'approved', approver: 'alice', at, attempts });
    expect(gate).toMatchObject({ gate: '正式核准', pass: true, commit: COMMIT });
    expect(patch.approval).toEqual({
      approver: 'alice', at, digest: D,
      unauthorizedAttempts: [{ id: 'mallory', at, action: 'approve' }, { id: '（帳號格式無效）', at: '未執行', action: 'unknown' }],
    });
    expect(evidence.approver).toBe('alice');
    const rec = createRecord({ job: 'release/little-moments/v1.2.3', number: 4, url: 'u', commit: COMMIT, trigger: 'release_tag', ref: TAG, buildImageDigest: P });
    expect(validateRecord(addGateResult(mergeRecord(rec, patch), gate)).ok).toBe(true);
  });

  test('拒絕、逾時、中止、Tag 已變更與破壞性遷移未核准皆未通過；拒絕記錄帳號與時間（Req 19.4、19.7、19.8、12.6）', () => {
    const rejected = approvalRecord({ ...base, decision: 'rejected', rejectedBy: 'bob', rejectedAt: at });
    expect(rejected.gate.pass).toBe(false);
    expect(rejected.gate.unmet[0]).toContain('bob');
    expect(rejected.gate.unmet[0]).toContain(at);
    expect(rejected.patch.approval.approver).toBeUndefined();
    expect(rejected.evidence).toMatchObject({ rejectedBy: 'bob', rejectedAt: at });
    expect(approvalRecord({ ...base, decision: 'timeout' }).gate.unmet[0]).toContain('24 小時');
    expect(approvalRecord({ ...base, decision: 'tag_changed', approver: 'alice', at }).gate.unmet.join()).toContain('Req 19.8');
    const pending = [{ version: 2, migration: 'migrations/0002_drop_x.sql' }];
    expect(approvalRecord({ ...base, decision: 'approved', approver: 'alice', at, pendingDestructive: pending }).gate.pass).toBe(false);
    const done = approvalRecord({ ...base, decision: 'approved', approver: 'alice', at, pendingDestructive: pending, destructive: [{ version: 2, migration: 'migrations/0002_drop_x.sql', approver: 'carol', at }] });
    expect(done.gate.pass).toBe(true);
    expect(done.evidence.destructiveApprovals).toEqual([{ version: 2, migration: 'migrations/0002_drop_x.sql', approver: 'carol', at }]);
    expect(approvalRecord({ ...base, decision: 'something' }).gate.pass).toBe(false);
  });
});

describe('CLI（Jenkinsfile 使用的檔名與參數）', () => {
  const run = (argv) => {
    const out = [];
    const code = main(argv, { log: (s) => out.push(s), error: (s) => out.push(s) });
    return { code, out };
  };
  const file = (name, text) => { const p = join(tmp, name); writeFileSync(p, text); return p; };

  test('observe：逐筆追加並判定；連續 3 次失敗時結束碼 1', () => {
    const obs = join(tmp, 'observations.json');
    const out = join(tmp, 'decision.json');
    const ok = file('health-ok.jsonl', healthOnce('green'));
    const bad = file('health-bad.jsonl', healthOnce('green', false));
    expect(run(['observe', '--obs', obs, '--type', 'health', '--t', '0', '--exit', '0', '--result', ok, '--color', 'green', '--out', out]).code).toBe(0);
    expect(run(['observe', '--obs', obs, '--type', 'smoke', '--t', '1', '--exit', '0', '--result', file('smoke.json', smokeText()), '--phase', 'after-switch', '--out', out]).code).toBe(0);
    for (const t of ['10', '20']) expect(run(['observe', '--obs', obs, '--type', 'health', '--t', t, '--exit', '1', '--result', bad, '--color', 'green', '--out', out]).code).toBe(0);
    expect(run(['observe', '--obs', obs, '--type', 'health', '--t', '30', '--exit', '1', '--result', bad, '--color', 'green', '--out', out]).code).toBe(1);
    const decision = JSON.parse(readFileSync(out, 'utf8'));
    expect(decision).toMatchObject({ rollback: true, reason: 'Health_Check 連續 3 次失敗（切換後 10、20、30 秒）' });
    expect(JSON.parse(readFileSync(obs, 'utf8'))).toHaveLength(5);
    expect(run(['observe', '--obs', obs, '--type', 'smoke', '--t', '1', '--exit', '0', '--result', ok, '--out', out]).code).toBe(2);
  });

  test('record：讀取 reports/production 的判讀檔，輸出 patch、關卡與回滾摘要', () => {
    const dir = join(tmp, 'production');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy-verdict.json'), j(classifyDeploy(0, deployOutput(), D)));
    writeFileSync(join(dir, 'observations.json'), j(fullObservation({ smokeFail: new Set(['after-switch']) }).slice(0, 2)));
    const rb = j({ ok: true, command: 'rollback', env: 'prod', mode: 'auto', from: { color: 'green', digest: D }, to: { color: 'blue', digest: P }, restored: true, migrationsRun: false });
    writeFileSync(join(dir, 'restore.json'), j(classifyRestore({ statusText: statusLine(), digest: D, rollbackAttempted: true, rollbackExit: 0, rollbackText: rb, healthExit: 0, healthText: healthWait('blue') })));
    const patchFile = join(tmp, 'patch.json');
    const gateFile = join(tmp, 'gate.json');
    const r = run(['record', '--dir', dir, '--commit', COMMIT, '--digest', D, '--tag', TAG, '--signature', 'ok', '--finalize', 'not_run', '--out-patch', patchFile, '--out-gate', gateFile]);
    expect(r.code).toBe(1);
    const patch = JSON.parse(readFileSync(patchFile, 'utf8'));
    expect(patch.rollback).toMatchObject({ trigger: 'auto', from: D, to: P });
    expect(patch.reports).toMatchObject({ productionObservation: `${dir.replace(/\\/g, '/')}/observations.json`, productionRestore: `${dir.replace(/\\/g, '/')}/restore.json` });
    expect(validateRecord(patch).ok).toBe(true);
    expect(readFileSync(join(dir, 'rollback-summary.txt'), 'utf8')).toContain('Smoke_Test 失敗');
  });

  test('destructive、tag-remote 與 approval-record', () => {
    const mig = join(tmp, 'migrations');
    mkdirSync(mig, { recursive: true });
    writeFileSync(join(mig, '0001_initial.sql'), 'CREATE TABLE t (id INTEGER);\n');
    writeFileSync(join(mig, '0002_drop_x.sql'), '-- lm:destructive\nALTER TABLE t DROP COLUMN x;\n');
    const out = join(tmp, 'destructive.json');
    expect(run(['destructive', '--migrations', mig, '--deployed', file('deployed.txt', 'migrations/0001_initial.sql\n'), '--out', out]).code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ known: true, pending: [{ version: 2, migration: 'migrations/0002_drop_x.sql' }] });
    expect(run(['destructive', '--migrations', mig, '--deployed', 'unknown', '--out', out]).code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).known).toBe(false);

    expect(run(['tag-remote', '--result', file('ls.txt', `${COMMIT}\trefs/tags/${TAG}\n`), '--tag', TAG, '--commit', COMMIT]).code).toBe(0);
    expect(run(['tag-remote', '--result', file('ls2.txt', `${OTHER}\trefs/tags/${TAG}\n`), '--tag', TAG, '--commit', COMMIT]).code).toBe(1);

    const input = file('approval-input.json', j({ decision: 'approved', approver: 'alice', at: '2026-01-02T09:00:00+08:00', digest: D, tag: TAG, commit: COMMIT, attempts: [], destructive: [], pendingDestructive: [] }));
    const r = run(['approval-record', '--in', input, '--out-patch', join(tmp, 'ap.json'), '--out-gate', join(tmp, 'ag.json'), '--out-evidence', join(tmp, 'ae.json')]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'ag.json'), 'utf8'))).toMatchObject({ gate: '正式核准', pass: true });
  });
});

// ---------------------------------------------------------------- 性質

// 獨立 oracle：Req 20.6 的回滾條件（觀察期內連續 3 次 Health_Check 失敗，或任一次 Smoke_Test 失敗）。
function oracleRollback(obs) {
  let streak = 0;
  for (const o of obs) {
    if (o.t < 0 || o.t > 600) continue;
    if (o.type === 'smoke') { if (!o.ok) return true; continue; }
    streak = o.ok ? 0 : streak + 1;
    if (streak >= 3) return true;
  }
  return false;
}

const observationArb = fc.record({
  healthOk: fc.array(fc.oneof({ weight: 5, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }), { minLength: 0, maxLength: 60 }),
  afterOk: fc.option(fc.boolean(), { nil: null }),
  endOk: fc.option(fc.boolean(), { nil: null }),
}).map(({ healthOk, afterOk, endOk }) => {
  const obs = [];
  healthOk.forEach((ok, i) => {
    obs.push({ type: 'health', t: i * 10, ok, durationMs: 10 });
    if (i === 0 && afterOk !== null) obs.push({ type: 'smoke', t: 2, ok: afterOk, phase: 'after-switch', failedSteps: afterOk ? [] : ['trips'] });
    if (i === 54 && endOk !== null) obs.push({ type: 'smoke', t: 542, ok: endOk, phase: 'before-end', failedSteps: endOk ? [] : ['login'] });
  });
  return obs;
});

describe('性質', () => {
  // Feature: jenkins-cicd-deploy, Property 40: 健康檢查判定器（Production 觀察期）
  // **Validates: Requirements 20.5, 20.6, 23.2**
  test('Property 40（Production）：回滾 ⇔ 連續 3 次 Health_Check 失敗或任一 Smoke_Test 失敗；觀察期完整 ⇔ 60 次檢查且兩次 Smoke_Test 皆通過且不需回滾', () => {
    fc.assert(fc.property(observationArb, (obs) => {
      const d = observationDecision(obs);
      expect(d.rollback).toBe(oracleRollback(obs));
      const healthCount = obs.filter((o) => o.type === 'health').length;
      const after = obs.find((o) => o.phase === 'after-switch');
      const end = obs.find((o) => o.phase === 'before-end');
      const complete = healthCount === 60 && after?.ok === true && end?.ok === true && !d.rollback;
      expect(d.summary.complete).toBe(complete);
      if (d.rollback) {
        // 觸發點是第一個滿足條件的觀察位置：之前的前綴不需回滾。
        expect(oracleRollback(obs.slice(0, d.trigger.index))).toBe(false);
        expect(oracleRollback(obs.slice(0, d.trigger.index + 1))).toBe(true);
      }
    }), { numRuns: 200 });
  });

  // Feature: jenkins-cicd-deploy, Property 45: Release_Gate 依序評估並在第一個失敗處停止（「上線後」與「正式核准」的 fail closed）
  // **Validates: Requirements 19.4, 19.7, 19.8, 23.1, 23.2, 23.3**
  test('Property 45（Production）：「上線後」通過 ⇔ 簽章、切換、完整觀察期、finalize 皆成立且無階段錯誤；「正式核准」通過 ⇔ approved 且破壞性遷移皆已核准', () => {
    const deployOk = classifyDeploy(0, deployOutput(), D);
    const deployBad = classifyDeploy(1, j({ ok: false, command: 'migrate', reason: 'migrate_failed' }), D);
    fc.assert(fc.property(
      fc.constantFrom('ok', 'fail', 'not_run'), fc.constantFrom('ok', 'fail', 'not_run'), fc.boolean(), observationArb,
      fc.option(fc.constantFrom('觀察期逾時或被中止', 'Production 部署逾時或被中止'), { nil: null }),
      (signature, finalize, switched, obs, stageError) => {
        const deploy = switched ? deployOk : deployBad;
        const { gate, patch } = productionRecord({ commit: COMMIT, digest: D, tag: TAG, deploy, observations: obs, signature, finalize, stageError });
        const complete = observationSummary(obs).complete;
        const expected = signature === 'ok' && switched && complete && finalize === 'ok' && stageError === null;
        expect(gate.pass).toBe(expected);
        expect(gate.unmet.length === 0).toBe(expected);
        expect(validateRecord(patch).ok).toBe(true);
      },
    ), { numRuns: 200 });

    const migrations = fc.uniqueArray(fc.integer({ min: 1, max: 50 }), { maxLength: 4 }).map((vs) => vs.map((v) => ({ version: v, migration: `migrations/${String(v).padStart(4, '0')}_m.sql` })));
    fc.assert(fc.property(
      fc.constantFrom('approved', 'rejected', 'timeout', 'aborted', 'tag_changed', 'destructive_rejected', 'bogus'),
      migrations, fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), fc.constantFrom('alice', '', 'bad id'),
      (decision, pending, approvedMask, approver) => {
        const destructive = pending.filter((_, i) => approvedMask[i]).map((p) => ({ ...p, approver: 'carol', at: '2026-01-02T09:00:00+08:00' }));
        const { gate, patch } = approvalRecord({
          decision, approver, at: '2026-01-02T09:00:00+08:00', digest: D, tag: TAG, commit: COMMIT,
          attempts: [], destructive, pendingDestructive: pending,
        });
        const expected = decision === 'approved' && approver === 'alice' && destructive.length === pending.length;
        expect(gate.pass).toBe(expected);
        expect(validateRecord(patch).ok).toBe(true);
        if (!expected) expect(gate.unmet.length).toBeGreaterThan(0);
      },
    ), { numRuns: 200 });
  });
});
