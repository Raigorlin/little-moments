// ci/rollback.mjs：手動回滾的檢查、結果判讀與 Build_Record（Req 20.8–20.12；Property 41 的回滾目標驗證）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  INVALID_REASON_PLACEHOLDER, REASON_MAX, buildRollbackRecord, checkRollback, classifyHealth, classifyRollback, main,
  parseStatus, rollbackTargets, validateReason,
} from '../ci/rollback.mjs';
import { validateRecord } from '../ci/record.mjs';
import { retainImages, rollbackAllowed } from '../ci/retention.mjs';

const RUNS = { numRuns: 200 };
const d = (c) => `sha256:${c.repeat(64)}`;
const [A, B, C, D] = [d('a'), d('b'), d('c'), d('d')];
const approvers = { schema: 1, approvers: [{ jenkinsId: 'alice', emails: ['alice@example.invalid'] }, { jenkinsId: 'bob', emails: ['bob@example.invalid'] }] };

/** 與 deploy/bin/lm-deploy status_json 相同形狀的一行 JSON。 */
function statusLine({ phase = 'idle', active = { color: 'green', digest: C }, history = [A, B, C], deployInProgress = false, ...extra } = {}) {
  const retained = retainImages(history, 3).retained;
  const rollbackTargetsList = retained.filter((x) => x !== active?.digest);
  return JSON.stringify({
    ok: true, command: 'status', env: 'prod', phase, active, candidate: null, previous: null, history, retained,
    rollbackTargets: rollbackTargetsList, deployInProgress, lastBackup: null, backups: { count: 0, latest: null }, ...extra,
  });
}
const statusOf = (opts) => parseStatus(statusLine(opts)).status;
const okRequest = (over = {}) => ({ triggeredBy: 'alice', approver: 'alice', approvers, reason: '新版登入失敗', digest: B, status: statusOf(), ...over });
const healthResults = [{ t: 0, ok: true, durationMs: 10 }, { t: 5, ok: true, durationMs: 10 }, { t: 10, ok: true, durationMs: 10 }];

describe('validateReason', () => {
  test('去除前後空白；空白、過長、控制字元與疑似秘密皆拒絕', () => {
    expect(validateReason('  新版登入失敗  ')).toEqual({ ok: true, value: '新版登入失敗' });
    expect(validateReason('   ').ok).toBe(false);
    expect(validateReason(undefined).ok).toBe(false);
    expect(validateReason('字'.repeat(REASON_MAX)).ok).toBe(true);
    expect(validateReason('字'.repeat(REASON_MAX + 1)).ok).toBe(false);
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u202eb', 'a\u2028b', '\ud800']) expect(validateReason(bad).ok).toBe(false);
    expect(validateReason('Bearer abcdefghijklmnop').ok).toBe(false);
  });

  test('property：含任一控制字元的理由一律拒絕；不含者（非空、長度內）接受且值為 trim 結果', () => {
    const safeChar = fc.constantFrom(...'abc 日子拾光-_.,:;()?!0123456789');
    const ctrl = fc.integer({ min: 0, max: 0x1f }).map((n) => String.fromCharCode(n));
    fc.assert(fc.property(fc.array(safeChar, { minLength: 1, maxLength: 60 }).map((a) => a.join('')), ctrl, fc.nat(), (s, c, pos) => {
      const i = pos % (s.length + 1);
      expect(validateReason(s.slice(0, i) + c + s.slice(i)).ok).toBe(false);
      const r = validateReason(s);
      if (s.trim() === '') expect(r.ok).toBe(false);
      else expect(r).toEqual({ ok: true, value: s.trim() });
    }), RUNS);
  });
});

describe('parseStatus / rollbackTargets', () => {
  test('解析 lm-deploy status 的最後一行 JSON；格式不符一律無效', () => {
    const s = parseStatus(`[lm-deploy] noise\n${statusLine()}\n`);
    expect(s.ok).toBe(true);
    expect(s.status.active).toEqual({ color: 'green', digest: C });
    expect(rollbackTargets(s.status)).toEqual([B, A]);
    expect(parseStatus('').ok).toBe(false);
    expect(parseStatus(statusLine({ env: 'staging' })).ok).toBe(false);
    expect(parseStatus(JSON.stringify({ ...JSON.parse(statusLine()), retained: ['sha256:xyz'] })).ok).toBe(false);
    expect(parseStatus(JSON.stringify({ ...JSON.parse(statusLine()), ok: false })).ok).toBe(false);
  });

  test('rollbackTargets 排除目前版本與不在 retained 的項目', () => {
    const s = statusOf();
    expect(rollbackTargets({ ...s, rollbackTargets: [C, B, D, B] })).toEqual([B]);
  });
});

describe('checkRollback（Req 20.10、20.12）', () => {
  test('允許：觸發者與送出者為同一 Release_Approver、理由有效、digest 在保留集合', () => {
    expect(checkRollback(okRequest())).toMatchObject({ allowed: true });
  });

  test.each([
    ['not_release_approver', { triggeredBy: 'mallory', approver: 'mallory' }],
    ['not_release_approver', { triggeredBy: '' }],
    ['submitter_mismatch', { approver: 'bob' }],
    ['invalid_reason', { reason: '' }],
    ['invalid_reason', { reason: 'line1\nline2' }],
    ['invalid_digest', { digest: 'latest' }],
    ['deploy_in_progress', { status: statusOf({ phase: 'switched', active: { color: 'green', digest: C } }) }],
    ['deploy_in_progress', { status: statusOf({ deployInProgress: true }) }],
    ['already_active', { digest: C }],
    ['not_retained', { digest: D }],
  ])('拒絕：%s', (code, over) => {
    const r = checkRollback(okRequest(over));
    expect(r.allowed).toBe(false);
    expect(r.code).toBe(code);
  });

  test('核准人清單無效時一律拒絕（fail closed）', () => {
    expect(checkRollback(okRequest({ approvers: { approvers: [{ jenkinsId: 'alice' }] } })).allowed).toBe(false);
  });

  test('property：其他條件成立時，允許若且唯若 digest 屬於保留集合且不是目前版本（rollbackAllowed）', () => {
    const digest = fc.constantFrom(A, B, C, D, d('e'), d('f'));
    fc.assert(fc.property(fc.array(digest, { minLength: 1, maxLength: 8 }), digest, (history, candidate) => {
      const active = { color: 'blue', digest: history[history.length - 1] };
      const status = statusOf({ history, active });
      const retained = retainImages(history, 3);
      const expected = rollbackAllowed(candidate, retained) && candidate !== active.digest;
      expect(checkRollback(okRequest({ digest: candidate, status })).allowed).toBe(expected);
    }), RUNS);
  });
});

describe('classifyRollback / classifyHealth', () => {
  const ok = JSON.stringify({ ok: true, command: 'rollback', env: 'prod', mode: 'manual', from: { color: 'green', digest: C }, to: { color: 'blue', digest: B }, results: healthResults, migrationsRun: false });
  const fail = (reason) => JSON.stringify({ ok: false, command: 'rollback', env: 'prod', reason, message: 'x' });

  test('成功切換需輸出與目標相符、未執行遷移且切換前健康', () => {
    expect(classifyRollback(0, ok, B)).toMatchObject({ outcome: 'switched', manualIntervention: false, color: 'blue' });
    expect(classifyRollback(0, ok, A)).toMatchObject({ outcome: 'manual_intervention', manualIntervention: true });
    expect(classifyRollback(0, ok.replace('"migrationsRun":false', '"migrationsRun":true'), B).outcome).toBe('manual_intervention');
    expect(classifyRollback(0, '', B).outcome).toBe('manual_intervention');
  });

  test('結束碼對應：4 鎖、2 拒絕、3 狀態、1 依原因區分、其他狀態不明', () => {
    expect(classifyRollback(4, fail('deploy_in_progress'), B)).toMatchObject({ outcome: 'locked', manualIntervention: false });
    expect(classifyRollback(2, fail('rollback_not_allowed'), B)).toMatchObject({ outcome: 'rejected', manualIntervention: false });
    expect(classifyRollback(3, fail('invalid_phase'), B)).toMatchObject({ outcome: 'rejected', manualIntervention: false });
    expect(classifyRollback(3, fail('state_invalid'), B)).toMatchObject({ outcome: 'manual_intervention', manualIntervention: true });
    expect(classifyRollback(1, fail('health_failed'), B)).toMatchObject({ outcome: 'failed', manualIntervention: false });
    expect(classifyRollback(1, fail('start_failed'), B)).toMatchObject({ outcome: 'failed', manualIntervention: false });
    expect(classifyRollback(1, fail('switch_failed'), B)).toMatchObject({ outcome: 'manual_intervention', manualIntervention: true });
    expect(classifyRollback(255, '', B)).toMatchObject({ outcome: 'manual_intervention', manualIntervention: true });
  });

  test('切換後健康：結束碼 0 且 120 秒內連續 3 次成功（Req 20.11）', () => {
    const line = (results, extra = {}) => JSON.stringify({ ok: true, command: 'health', env: 'prod', color: 'blue', healthy: true, results, ...extra });
    expect(classifyHealth(0, line(healthResults)).healthy).toBe(true);
    expect(classifyHealth(0, line(healthResults.slice(0, 2))).healthy).toBe(false);
    expect(classifyHealth(0, line([{ t: 0, ok: true }, { t: 5, ok: false }, { t: 10, ok: true }, { t: 125, ok: true }])).healthy).toBe(false);
    expect(classifyHealth(1, JSON.stringify({ ok: false, command: 'health', reason: 'health_failed' }))).toMatchObject({ healthy: false, code: 'health_failed' });
    expect(classifyHealth(255, '').healthy).toBe(false);
  });
});

describe('buildRollbackRecord（Req 20.9、20.11）', () => {
  const base = {
    job: 'release/rollback', number: 7, url: 'https://jenkins.lan.example/job/release/job/rollback/7/', startedAt: '2025-01-01T00:00:00+00:00',
    endedAt: '2025-01-01T00:05:00+00:00', commit: 'f'.repeat(40), buildImageDigest: D, by: 'alice', approver: 'alice',
    approvedAt: '2025-01-01T00:01:00+00:00', from: C, to: B, reason: ' 新版登入失敗 ',
  };

  test('完成：rollback 區段含觸發方式、帳號、來源與目標、理由與完成時間；未執行遷移', () => {
    const r = buildRollbackRecord({ ...base, outcome: 'completed', attempted: true, status: 'SUCCESS' });
    expect(validateRecord(r).ok).toBe(true);
    expect(r.rollback).toEqual({ trigger: 'manual', by: 'alice', from: C, to: B, reason: '新版登入失敗', at: base.endedAt });
    expect(r.deployments).toEqual([{ env: 'production', digest: B, from: C, at: base.endedAt, result: 'completed', migrationsRun: false, manualInterventionRequired: false }]);
    expect(r.result).toEqual({ status: 'SUCCESS', firstFailedStage: '不適用' });
    expect(r.image.digest).toBe('不適用'); // 回滾紀錄不得被 digest 查詢誤認為產生該映像的建置
  });

  test('切換後未健康：記錄失敗與需人工介入', () => {
    const r = buildRollbackRecord({ ...base, outcome: 'manual_intervention', attempted: true, manualIntervention: true, status: 'FAILURE', firstFailedStage: 'Rollback' });
    expect(r.deployments[0]).toMatchObject({ result: 'manual_intervention', manualInterventionRequired: true, migrationsRun: false });
    expect(r.result).toEqual({ status: 'FAILURE', firstFailedStage: 'Rollback' });
  });

  test('拒絕（未送出回滾）：不記錄部署；無效理由不保存原文；無效 digest 不寫入', () => {
    const r = buildRollbackRecord({ ...base, by: 'mallory', approver: '', to: 'not-a-digest', reason: 'x\ny', outcome: 'rejected', status: 'FAILURE', firstFailedStage: 'Init' });
    expect(validateRecord(r).ok).toBe(true);
    expect(r.deployments).toBe('不適用');
    expect(r.rollback).toMatchObject({ by: 'mallory', to: '不適用', reason: INVALID_REASON_PLACEHOLDER });
    expect(r.approval.approver).toBe('不適用');
    expect(() => buildRollbackRecord({ ...base, outcome: 'bogus', status: 'FAILURE' })).toThrow();
  });
});

describe('CLI', () => {
  const files = (map) => (p) => { if (!(p in map)) throw new Error('ENOENT'); return map[p]; };
  const run = (argv, { fsMap = {}, env = {} } = {}) => {
    const out = [];
    const code = main(argv, { log: (l) => out.push(l), error: (l) => out.push(l), readFile: files({ 'approvers.json': JSON.stringify(approvers), ...fsMap }), env });
    return { code, out: out.join('\n') };
  };

  test('check 只從 LM_ROLLBACK_REASON 讀取理由', () => {
    const fsMap = { 's.json': statusLine() };
    const argv = ['check', '--status', 's.json', '--digest', B, '--triggered-by', 'alice', '--approver', 'alice', '--file', 'approvers.json'];
    expect(run(argv, { fsMap, env: { LM_ROLLBACK_REASON: '新版登入失敗' } })).toMatchObject({ code: 0 });
    const denied = run(argv, { fsMap, env: {} });
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.out)).toMatchObject({ allowed: false, code: 'invalid_reason' });
    expect(run([...argv.slice(0, 4), D, ...argv.slice(5)], { fsMap, env: { LM_ROLLBACK_REASON: 'x' } }).code).toBe(1);
  });

  test('targets：有目標結束碼 0、沒有目標 1、輸入無效 2', () => {
    expect(run(['targets', '--status', 's.json'], { fsMap: { 's.json': statusLine() } })).toMatchObject({ code: 0 });
    expect(JSON.parse(run(['targets', '--status', 's.json'], { fsMap: { 's.json': statusLine() } }).out).targets).toEqual([B, A]);
    expect(run(['targets', '--status', 's.json'], { fsMap: { 's.json': statusLine({ history: [C] }) } }).code).toBe(1);
    expect(run(['targets', '--status', 's.json'], { fsMap: { 's.json': 'garbage' } }).code).toBe(2);
    expect(run(['bogus']).code).toBe(2);
  });

  test('approvers 輸出 Jenkins ID 清單；repository 內的清單可解析', () => {
    expect(JSON.parse(run(['approvers', '--file', 'approvers.json']).out)).toEqual({ ok: true, approvers: ['alice', 'bob'] });
    const repo = main(['approvers'], { log: () => {}, error: () => {} });
    expect(repo).toBe(0);
  });

  test('以子行程執行 record：寫入通過驗證的 Build_Record，理由經環境變數傳入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-rollback-'));
    try {
      const out = join(dir, 'build-record.json');
      const proc = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../ci/rollback.mjs'), 'record', '--out', out,
        '--job', 'release/rollback', '--number', '3', '--url', 'https://jenkins.lan.example/x/3/', '--started-at', '2025-01-01T00:00:00+00:00',
        '--commit', 'a'.repeat(40), '--build-image-digest', D, '--by', 'alice', '--approver', 'alice', '--approved-at', '2025-01-01T00:01:00+00:00',
        '--from', C, '--to', B, '--outcome', 'completed', '--attempted', 'true', '--manual-intervention', 'false',
        '--status', 'SUCCESS', '--first-failed-stage', ''], { env: { ...process.env, LM_ROLLBACK_REASON: '以命令列外的方式傳入' } });
      expect(proc.exitCode).toBe(0);
      const rec = JSON.parse(readFileSync(out, 'utf8'));
      expect(validateRecord(rec).ok).toBe(true);
      expect(rec.rollback).toMatchObject({ trigger: 'manual', by: 'alice', from: C, to: B, reason: '以命令列外的方式傳入' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
