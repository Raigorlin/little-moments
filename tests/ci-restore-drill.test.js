// 還原演練（Requirement 14.6、14.7、21.10；tasks 14.5）：ci/restore-drill.mjs 的判讀與 Build_Record，
// 以及 ci/jenkins/pipelines/restore-drill.Jenkinsfile、deploy/compose/drill.yaml、deploy/bin/lm-deploy drill 的靜態檢查。
// 本機沒有 Jenkins／Docker，靜態檢查只驗證結構、關鍵字與隔離設定，不能取代 Deploy_Host 上的實際演練。
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NOT_APPLICABLE, NOT_RUN, auditSummary, validateRecord } from '../ci/record.mjs';
import { DRILL_STEPS, buildDrillRecord, main, parseDrillResult } from '../ci/restore-drill.mjs';
import { imageContentCheck } from '../ci/image-content-check.mjs';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'aeecb96702dbd01b605994fa717382df0b63806e803487626b8877e5388160bd';
const BACKUP_ID = 'prod-20300102T000000Z-aeecb96';
const COMMIT = 'b'.repeat(40);

const hostLine = (over = {}) => JSON.stringify({
  ok: true, command: 'drill', env: 'prod', project: 'lm-drill-prod-5bfd36fa', backupId: BACKUP_ID,
  backup: { id: BACKUP_ID, createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA },
  digest: DIGEST, restoreSeconds: 12.5, result: 'pass', failedStep: null,
  migrations: { applied: ['20260101000000_app_schema.sql', '20260102000000_realtime.sql'], skipped: [] },
  verify: { authUsers: 3, profiles: 3 }, cleanedUp: true, backupCount: 14,
  startedAt: '2030-01-02T03:00:00+00:00', endedAt: '2030-01-02T03:05:00+00:00', ...over,
});
const failLine = (over = {}) => hostLine({ ok: false, reason: 'restore_failed', message: 'pg_restore 失敗', result: 'fail', failedStep: 'restore', verify: null, ...over });

describe('parseDrillResult（plan.md D8）', () => {
  test('結束碼 0、筆數驗證通過、drill 專案已銷毀 → 通過', () => {
    const d = parseDrillResult(0, `noise\n${hostLine()}\n`);
    expect(d).toMatchObject({
      passed: true, code: 'passed', failedStep: null, backupId: BACKUP_ID, digest: DIGEST, restoreSeconds: 12.5,
      verifyResult: 'pass', restored: { authUsers: 3, profiles: 3 }, migrations: { applied: 2, skipped: 0 }, cleanedUp: true, backupCount: 14,
    });
    expect(d.backup).toEqual({ id: BACKUP_ID, createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA });
  });

  test('還原失敗：記錄失敗步驟與使用的備份識別碼，筆數驗證未執行', () => {
    const d = parseDrillResult(1, failLine());
    expect(d).toMatchObject({ passed: false, code: 'restore_failed', failedStep: 'restore', backupId: BACKUP_ID, verifyResult: 'not_run', restored: null, restoreSeconds: 12.5 });
  });

  test('筆數驗證失敗（profiles 多於 auth.users 或查詢失敗）→ 未通過，failedStep 為 verify', () => {
    const more = parseDrillResult(1, failLine({ reason: 'verify_failed', failedStep: 'verify', verify: { authUsers: 1, profiles: 2 } }));
    expect(more).toMatchObject({ passed: false, failedStep: 'verify', verifyResult: 'fail', restored: { authUsers: 1, profiles: 2 } });
    const none = parseDrillResult(1, failLine({ reason: 'verify_failed', failedStep: 'verify', verify: null }));
    expect(none).toMatchObject({ passed: false, failedStep: 'verify', verifyResult: 'fail', restored: null });
    // 就算 lm-deploy 回報成功，profiles > authUsers 也不通過（fail closed）。
    expect(parseDrillResult(0, hostLine({ verify: { authUsers: 1, profiles: 2 } }))).toMatchObject({ passed: false, failedStep: 'verify' });
  });

  test('Supabase 服務啟動與遷移失敗的步驟名稱屬於 DRILL_STEPS', () => {
    for (const [reason, step] of [['stack_db_failed', 'db_start'], ['stack_auth_failed', 'stack_start'], ['migrate_failed', 'migrate'], ['drill_keys_failed', 'setup']]) {
      const d = parseDrillResult(1, failLine({ reason, failedStep: step, restoreSeconds: null }));
      expect(d).toMatchObject({ passed: false, code: reason, failedStep: step });
      expect(DRILL_STEPS).toContain(d.failedStep);
    }
    expect(DRILL_STEPS).toEqual(['backup_select', 'backup_verify', 'setup', 'db_start', 'stack_start', 'migrate', 'restore', 'verify', 'cleanup']);
  });

  test('fail closed：結束碼非 0、result 非 pass、未銷毀、格式不符或非 prod drill 輸出皆不通過', () => {
    expect(parseDrillResult(1, hostLine()).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ result: 'fail' })).passed).toBe(false);
    const notCleaned = parseDrillResult(0, hostLine({ cleanedUp: false }));
    expect(notCleaned).toMatchObject({ passed: false, failedStep: 'cleanup' });
    expect(parseDrillResult(0, hostLine({ backupId: 'staging-20300102T000000Z-aeecb96' })).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ digest: 'sha256:abc' })).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ env: 'staging' }))).toMatchObject({ passed: false, code: 'invalid_output', backupId: null });
    expect(parseDrillResult(0, hostLine({ verify: { authUsers: -1, profiles: 0 } }))).toMatchObject({ passed: false, verifyResult: 'not_run' });
    expect(parseDrillResult(0, hostLine({ verify: { authUsers: '3', profiles: 3 } })).passed).toBe(false);
    expect(parseDrillResult(255, '')).toMatchObject({ passed: false, code: 'ssh_failed', failedStep: 'output' });
    expect(parseDrillResult(4, JSON.stringify({ ok: false, command: 'drill', env: 'prod', reason: 'drill_in_progress' }))).toMatchObject({ passed: false, code: 'drill_in_progress' });
  });

  test('只保留數量：遷移檔名格式不符時不記錄遷移數量；不保留其他欄位', () => {
    const d = parseDrillResult(0, hostLine({ migrations: { applied: ['../../etc/passwd'], skipped: [] }, extra: 'secret' }));
    expect(d.migrations).toBeNull();
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(JSON.stringify(d)).not.toContain('passwd');
  });
});

describe('buildDrillRecord（Req 14.6、14.7）', () => {
  const base = { job: 'release/restore-drill', number: 7, url: 'https://jenkins.lan.example/job/7/', startedAt: '2030-01-02T03:00:00+00:00', endedAt: '2030-01-02T03:06:00+00:00', commit: COMMIT, buildImageDigest: DIGEST, by: 'timer' };

  test('通過：記錄備份識別碼、還原秒數、筆數驗證與遷移數量，紀錄通過白名單驗證', () => {
    const r = buildDrillRecord({ ...base, drill: parseDrillResult(0, hostLine()), status: 'SUCCESS' });
    expect(validateRecord(r).ok).toBe(true);
    expect(r.backup).toEqual({ id: BACKUP_ID, env: 'production', createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA });
    expect(r.deployments).toHaveLength(1);
    expect(r.deployments[0]).toMatchObject({
      type: 'restore_drill', backupId: BACKUP_ID, restoreSeconds: 12.5, verifyResult: 'pass', restored: { authUsers: 3, profiles: 3 },
      migrations: { applied: 2, skipped: 0 }, result: 'pass', failedStep: NOT_APPLICABLE, backupsDeleted: 0, backupCount: 14, cleanedUp: true,
    });
    expect(r.deployments[0]).not.toHaveProperty('smokeResult');
    expect(r.result).toEqual({ status: 'SUCCESS', firstFailedStage: NOT_APPLICABLE });
    expect(r.source).toEqual({ commit: COMMIT, trigger: 'restore_drill', ref: 'release/restore-drill' });
    // 演練紀錄不是 Production 部署：digest 查詢不會把它當成部署時間。
    expect(r.image.digest).toBe(NOT_APPLICABLE);
    expect(auditSummary(r).productionDeployedAt).toBe(NOT_APPLICABLE);
  });

  test('失敗：建置標記為失敗並記錄失敗步驟與備份識別碼', () => {
    const r = buildDrillRecord({ ...base, drill: parseDrillResult(1, failLine()), status: 'FAILURE', firstFailedStage: 'Drill' });
    expect(validateRecord(r).ok).toBe(true);
    expect(r.result).toEqual({ status: 'FAILURE', firstFailedStage: 'Drill:restore' });
    expect(r.backup.id).toBe(BACKUP_ID);
    expect(r.deployments[0]).toMatchObject({ result: 'fail', failedStep: 'restore', verifyResult: 'not_run', restored: NOT_RUN, backupId: BACKUP_ID, backupsDeleted: 0 });
  });

  test('Pipeline 回報 SUCCESS 但演練未通過或未執行時，一律記為 FAILURE', () => {
    expect(buildDrillRecord({ ...base, drill: parseDrillResult(1, failLine()), status: 'SUCCESS' }).result.status).toBe('FAILURE');
    const none = buildDrillRecord({ ...base, drill: null, status: 'SUCCESS' });
    expect(none.result.status).toBe('FAILURE');
    expect(none.backup.id).toBe(NOT_RUN);
    expect(none.deployments).toBe(NOT_RUN);
    expect(validateRecord(none).ok).toBe(true);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-drill-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, error: () => {} };

  test('classify：通過 0、未通過 1、參數錯誤 2', () => {
    writeFileSync(join(dir, 'ok.jsonl'), hostLine() + '\n');
    writeFileSync(join(dir, 'fail.jsonl'), failLine() + '\n');
    expect(main(['classify', '--exit', '0', '--result', join(dir, 'ok.jsonl')], quiet)).toBe(0);
    expect(main(['classify', '--exit', '1', '--result', join(dir, 'fail.jsonl')], quiet)).toBe(1);
    expect(main(['classify', '--exit', 'x', '--result', join(dir, 'ok.jsonl')], quiet)).toBe(2);
    expect(main(['classify', '--exit', '0', '--result', join(dir, 'missing.jsonl')], quiet)).toBe(1);
  });

  test('record：寫入通過驗證的 Build_Record；未執行 drill（空字串參數）時記錄未執行', () => {
    const out = join(dir, 'record.json');
    const args = ['--job', 'release/restore-drill', '--number', '3', '--url', 'u', '--started-at', '2030-01-02T03:00:00+00:00',
      '--commit', COMMIT, '--build-image-digest', DIGEST, '--by', 'timer'];
    expect(main(['record', '--out', out, ...args, '--result', join(dir, 'fail.jsonl'), '--exit', '1', '--status', 'FAILURE', '--first-failed-stage', 'Drill'], quiet)).toBe(0);
    const rec = JSON.parse(readFileSync(out, 'utf8'));
    expect(rec.backup.id).toBe(BACKUP_ID);
    expect(rec.result.firstFailedStage).toBe('Drill:restore');
    expect(main(['record', '--out', out, ...args, '--result', '', '--exit', '', '--status', 'FAILURE', '--first-failed-stage', 'Init'], quiet)).toBe(0);
    const none = JSON.parse(readFileSync(out, 'utf8'));
    expect(none.backup.id).toBe(NOT_RUN);
    expect(none.result.firstFailedStage).toBe('Init');
  });
});

// ------------------------------------------------------------------ Jenkinsfile 靜態檢查

const jf = read('ci/jenkins/pipelines/restore-drill.Jenkinsfile');
const jfCode = jf.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const singleQuoted = (text) => [...text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  .matchAll(/'''([\s\S]*?)'''|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1] ?? m[2]);

describe('restore-drill.Jenkinsfile', () => {
  test('單一 Declarative pipeline，Trusted Agent、排程（兩次間隔 ≤ 30 日）、365 天保留且不並行', () => {
    expect(jfCode.match(/^pipeline\s*\{/gm)?.length).toBe(1);
    expect(jfCode).toContain("agent { label 'lm-trusted' }");
    expect(jfCode).toContain("cron('H 3 1,15 * *')");
    for (const opt of ['skipDefaultCheckout()', 'timestamps()', 'disableResume()', 'disableConcurrentBuilds()', "logRotator(daysToKeepStr: '365')"]) {
      expect(jfCode).toContain(opt);
    }
    expect([...jfCode.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['Init', 'Drill']);
    const post = jfCode.slice(jfCode.indexOf('post {'));
    expect(post).toMatch(/always\s*\{[\s\S]*writeDrillRecord\(\)[\s\S]*archiveArtifacts/);
  });

  test('括號成對，且沒有 Groovy 字串插值（不使用雙引號字串）', () => {
    const withoutSingle = jfCode.replace(/'''[\s\S]*?'''/g, "''").replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    expect(withoutSingle).not.toContain('"');
    const pairs = { ')': '(', '}': '{', ']': '[' };
    const stack = [];
    for (const ch of withoutSingle.replace(/\/\^[^\n]*?\$\//g, '')) {
      if ('({['.includes(ch)) stack.push(ch);
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch]);
    }
    expect(stack).toEqual([]);
    const scripts = [...jfCode.matchAll(/script:\s*([^\n]+)/g)].map((m) => m[1].trim());
    for (const s of scripts) expect(s.startsWith("'") || s === 'sshPrelude() + command)').toBe(true);
  });

  test('只呼叫 lm-deploy drill；從不呼叫 backup、prune 或會變更 Production 的子命令（Req 14.7 保留所有備份）', () => {
    const cmds = [...jf.matchAll(/'lm_ssh ([a-z-]+)/g)].map((m) => m[1]);
    expect(cmds).toEqual(['drill']);
    expect(singleQuoted(jf).join('\n')).not.toMatch(/lm_ssh (backup|prune|deploy|migrate|start|switch|rollback|finalize|app-env)\b|\brm\b[^\n]*(backup|\.dump)/i);
    expect([...jfCode.matchAll(/deployHost\('([a-z]+)'/g)].map((m) => m[1])).toEqual(['drill']);
  });

  test('未通過即將建置標記為失敗；Build_Record 經 ci/restore-drill.mjs record 寫入', () => {
    const drill = jfCode.slice(jfCode.indexOf("stage('Drill')"), jfCode.indexOf('post {'));
    expect(drill).toContain("deployHost('drill', 'drill.jsonl')");
    expect(drill).toMatch(/if \(v\.passed != true\) \{[\s\S]*error\(/);
    expect(jfCode).toContain('bun ci/restore-drill.mjs classify --exit "$LM_DRILL_EXIT" --result "$LM_DRILL_RESULT_FILE"');
    for (const arg of ['bun ci/restore-drill.mjs record --out "$LM_RECORD"', '--result "$LM_DRILL_RESULT_FILE" --exit "$LM_DRILL_EXIT"', '--status "$LM_DRILL_RESULT_STATUS"']) {
      expect(jfCode).toContain(arg);
    }
    expect(jfCode).toMatch(/if \(status == 'SUCCESS' && env\.LM_DRILL_PASSED != 'true'\) \{\s*status = 'FAILURE'/);
    // 摘要與環境變數使用筆數驗證結果（verifyResult），沒有 Bun 版的 Smoke_Test。
    expect(jfCode).toContain("env.LM_DRILL_VERIFY = (v.verifyResult ?: 'not_run').toString()");
    expect(jf).not.toMatch(/smokeResult|LM_DRILL_SMOKE|Smoke_Test/);
  });

  test('SSH：憑證只以 withCredentials 綁定、嚴格主機金鑰檢查；Build_Image 以固定 digest 引用', () => {
    expect([...jfCode.matchAll(/credentialsId:/g)].length).toBe(3);
    expect(jfCode).toContain("sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')");
    expect(jfCode).toContain("file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')");
    for (const opt of ['-F /dev/null', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile="$LM_KNOWN_HOSTS"', 'GlobalKnownHostsFile=/dev/null', 'BatchMode=yes', 'IdentityAgent=none']) {
      expect(jf).toContain(opt);
    }
    expect(jf).not.toMatch(/StrictHostKeyChecking=(no|accept-new)|ssh-keyscan/);
    expect(/BUILD_IMAGE = '([^']+)'/.exec(jfCode)?.[1]).toBe('registry.our-littlemoments.com:8443/little-moments/build-image@sha256:7eb66eee2631f762d0804dc57b59f2b42b6fba740cfabed3317624918397c97e');
    expect(jfCode).toContain('ReplayCause');
  });
});

// ------------------------------------------------------------------ drill.yaml 與 lm-deploy drill 靜態檢查

const drillYamlText = read('deploy/compose/drill.yaml');
const drillYaml = Bun.YAML.parse(drillYamlText);
const composeYaml = Bun.YAML.parse(read('deploy/compose/compose.yaml'));
const lmDeploy = read('deploy/bin/lm-deploy');

function shellFunction(src, name) {
  const start = src.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`找不到函式 ${name}`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

describe('deploy/compose/drill.yaml 隔離（Req 14.6；plan.md D8）', () => {
  const services = Object.entries(drillYaml.services);

  test('專案名稱來自 LM_DRILL_PROJECT，只有一個 internal 網路，沒有發布任何連接埠', () => {
    expect(drillYaml.name).toMatch(/^\$\{LM_DRILL_PROJECT:\?/);
    expect(Object.keys(drillYaml.networks)).toEqual(['drill']);
    expect(drillYaml.networks.drill.internal).toBe(true);
    expect(drillYaml.networks.drill.external).toBeUndefined();
    expect(Object.keys(drillYaml.services).sort()).toEqual(['auth', 'db', 'gateway', 'realtime']);
    for (const [name, svc] of services) {
      expect({ name, ports: svc.ports, expose: svc.expose, network_mode: svc.network_mode }).toEqual({ name, ports: undefined, expose: undefined, network_mode: undefined });
      expect(svc.networks).toEqual(['drill']);
      expect(svc.cap_drop).toEqual(['ALL']);
      expect(svc.security_opt).toEqual(['no-new-privileges:true']);
      expect(svc.restart).toBe('no');
      expect(svc.labels['lm.drill']).toMatch(/^\$\{LM_DRILL_ENV/);
    }
  });

  test('Database 只使用匿名卷；唯一的 bind mount 是唯讀的 gateway.Caddyfile（沒有具名卷或 Production 的 sbdata）', () => {
    expect(drillYaml.volumes).toBeUndefined();
    expect(drillYaml.services.db.volumes).toEqual(['/var/lib/postgresql/data']);
    for (const [name, svc] of services) {
      for (const v of svc.volumes ?? []) {
        if (name === 'gateway') expect(v).toBe('${LM_SUPABASE_DIR:?LM_SUPABASE_DIR 未設定}/gateway.Caddyfile:/etc/caddy/Caddyfile:ro');
        else expect(String(v)).not.toContain(':');
      }
    }
    expect(drillYamlText).not.toMatch(/pgdata:|sbdata:|lm-(prod|staging)_|external:\s*true/);
  });

  test('秘密只來自 lm-deploy 傳入的 drill.env（--env-file）；不讀取正式環境的 app.env、db.env 或 <env>.env', () => {
    for (const [, svc] of services) expect(svc.env_file).toBeUndefined();
    const yamlCode = drillYamlText.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(yamlCode).not.toMatch(/(?<![-\w])(app|db|prod|staging)\.env\b/);
    expect(drillYaml.services.db.environment.POSTGRES_PASSWORD).toMatch(/^\$\{LM_DB_PASSWORD:\?/);
    expect(drillYaml.services.auth.environment.GOTRUE_JWT_KEYS).toMatch(/^\$\{LM_JWT_KEYS:\?/);
    expect(drillYaml.services.gateway.environment.LM_ANON_KEY).toMatch(/^\$\{LM_ANON_KEY:\?/);
  });

  test('db、auth、realtime、gateway 的映像與 compose.yaml 相同；db 以 TCP pg_isready 判斷就緒', () => {
    for (const s of ['db', 'auth', 'realtime', 'gateway']) expect(drillYaml.services[s].image).toBe(composeYaml.services[s].image);
    expect(drillYaml.services.db.healthcheck.test.join(' ')).toContain('-h 127.0.0.1');
    expect(drillYamlText).not.toContain('APP_IMAGE');
  });
});

describe('lm-deploy drill', () => {
  const doDrill = shellFunction(lmDeploy, 'do_drill');

  test('子命令取 drill 專用鎖（不阻擋部署）且不寫入狀態檔', () => {
    expect(lmDeploy).toMatch(/drill\)\n\s+\(\(\$# == 0\)\) \|\| usage "drill 不接受參數"\n\s+acquire_drill_lock; load_state; load_env_config\n\s+do_drill/);
    expect(shellFunction(lmDeploy, 'acquire_drill_lock')).toContain('lm-$ENVN-drill.lock');
    expect(doDrill).not.toMatch(/save_state|acquire_lock\b/);
  });

  test('只讀取備份：drill 流程不修剪、不刪除任何備份檔（Req 14.7）', () => {
    for (const fn of ['do_drill', 'drill_fail', 'drill_down', 'drill_remove_dir', 'drill_fields', 'drill_purge_stale', 'drill_write_secrets']) {
      const body = shellFunction(lmDeploy, fn);
      expect(body).not.toMatch(/prune_backups|BACKUP_DIR[^\n]*\brm\b|\brm\b[^\n]*BACKUP_DIR|\bmv\b[^\n]*\.dump/);
    }
    expect(shellFunction(lmDeploy, 'drill_remove_dir')).toContain('$d == "$STATE_DIR"/.drill.*');
  });

  test('重算 sha256 後才還原；專案名稱與正式專案不同；所有 compose 呼叫都經 DRILL_CMD（drill.yaml + drill.env）', () => {
    const verify = doDrill.indexOf('backup_checksum_mismatch');
    const restore = doDrill.indexOf('pg_restore');
    expect(verify).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(verify);
    expect(doDrill).toContain('[[ $DRILL_PROJECT =~ $DRILL_PROJECT_RE && $DRILL_PROJECT != "lm-$ENVN" ]]');
    expect(lmDeploy).toContain("readonly DRILL_PROJECT_RE='^lm-drill-(staging|prod)-[0-9a-f]{8}$'");
    expect(doDrill).toContain('-f "$ENV_DIR/drill.yaml" --env-file "$DRILL_DIR/drill.env"');
    expect(doDrill).not.toContain('COMPOSE_CMD');
    expect(doDrill).not.toContain('compose.yaml');
    expect(doDrill).toContain('pg_restore --data-only --disable-triggers --no-owner --no-privileges --exit-on-error --single-transaction');
  });

  test('步驟順序：db + db-setup.sql → auth／realtime／gateway → 目前映像的遷移 → 還原 → 筆數驗證（plan.md D8）', () => {
    const at = ['stack_db_up DRILL_CMD', 'stack_services_up DRILL_CMD', 'run_migrations DRILL_CMD "$DRILL_DIGEST"', 'pg_restore --data-only', 'Q_DRILL_COUNTS', 'drill_down']
      .map((s) => doDrill.indexOf(s));
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const step of ['backup_select', 'backup_verify', 'setup', 'db_start', 'stack_start', 'migrate', 'restore', 'verify', 'cleanup']) {
      expect(doDrill).toMatch(new RegExp(`\\b${step}\\b`));
    }
    expect(lmDeploy).toContain('readonly Q_DRILL_COUNTS="select (select count(*) from auth.users) || \' \' || (select count(*) from app.profiles)"');
    expect(doDrill).toContain('((profiles <= users))');
  });

  test('任何結束路徑都 down -v；拋棄式金鑰只寫入 0600 的 drill.env，不輸出', () => {
    expect(shellFunction(lmDeploy, 'drill_down')).toContain('down -v --remove-orphans');
    expect(shellFunction(lmDeploy, 'cleanup')).toMatch(/DRILL_UP == 1 \]\]; then drill_down/);
    expect(shellFunction(lmDeploy, 'drill_fail')).toMatch(/drill_down[\s\S]*drill_remove_dir[\s\S]*die/);
    for (const sig of ["trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM"]) expect(doDrill).toContain(sig);
    const secrets = shellFunction(lmDeploy, 'drill_write_secrets');
    expect(secrets).toContain('chmod 0600');
    expect(secrets).toContain('"$keys" env drill >"$f"');
    expect(secrets).toContain('app_env_check "$f"');
    expect(secrets).not.toMatch(/emit|log |>&2/);
    // docker／pg_restore 輸出只進 0600 的 drill-last.log，不進 stdout／stderr。
    expect(doDrill).not.toContain('>&2');
    expect(doDrill).toContain('exec {XFD}>>"$DRILL_LOG"');
    expect(doDrill).toContain('chmod 0600 -- "$DRILL_LOG"');
  });
});
describe('安裝與打包', () => {
  test('install.sh 安裝 drill.yaml；build-server 打包 /app/tools/drill.js', () => {
    const install = read('deploy/host/install.sh');
    expect(install).toContain('SRC_DRILL="$DEPLOY_DIR/compose/drill.yaml"');
    expect(install).toContain('install_atomic "$SRC_DRILL" "$d/drill.yaml" 0644');
    expect(read('scripts/build-server.mjs')).toContain("{ entry: 'scripts/drill.mjs', dir: 'tools', name: 'drill.js' }");
  });

  test('App_Image 帶 /app/migrations（演練由映像取出遷移），映像內容檢查規則通過（plan.md D4、D8）', () => {
    // Dockerfile 複製整個 /out/（bin/、dist/、migrations/）。
    expect(read('Dockerfile')).toMatch(/COPY --from=build[^\n]* \/out\/ \/app\//);
    expect(read('Dockerfile')).toContain('cp supabase/migrations/*.sql /out/migrations/');
    const line = (mode, path) => `${mode} 0/0 100 2026-11-25 10:00 ${path}`;
    const files = [
      line('drwxr-xr-x', './'), line('drwxr-xr-x', 'app/'), line('-r-xr-xr-x', 'app/bin/little-moments-server'),
      line('-r--r--r--', 'app/dist/index.html'), line('-r--r--r--', 'app/dist/lm-web-1a2b_bg.wasm'),
      line('dr-xr-xr-x', 'app/migrations/'), line('-r--r--r--', 'app/migrations/20260101000000_app_schema.sql'),
    ];
    expect(imageContentCheck(files, '65532:65532')).toEqual({ ok: true, violations: [] });
  });
});
