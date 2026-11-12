// 還原演練（Requirement 14.6、14.7、21.10；tasks 14.5）：ci/restore-drill.mjs 的判讀與 Build_Record，
// 以及 ci/jenkins/pipelines/restore-drill.Jenkinsfile、deploy/compose/drill.yaml、deploy/bin/lm-deploy drill 的靜態檢查。
// 本機沒有 Jenkins／Docker，靜態檢查只驗證結構、關鍵字與隔離設定，不能取代 Deploy_Host 上的實際演練。
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NOT_APPLICABLE, NOT_RUN, auditSummary, validateRecord } from '../ci/record.mjs';
import { DRILL_STEPS, buildDrillRecord, main, parseDrillResult } from '../ci/restore-drill.mjs';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'aeecb96702dbd01b605994fa717382df0b63806e803487626b8877e5388160bd';
const BACKUP_ID = 'prod-20300102T000000Z-aeecb96';
const COMMIT = 'b'.repeat(40);

const toolOk = {
  ok: true, failedStep: null,
  steps: [
    { step: 'wait-healthy', status: 200, ms: 5, result: 'pass' }, { step: 'seed-admin', status: null, ms: 80, result: 'pass' },
    { step: 'fixture', status: null, ms: 20, result: 'pass' }, { step: 'smoke', status: null, ms: 30, result: 'pass' },
  ],
  smoke: { ok: true, steps: ['login-page', 'session', 'login', 'trips', 'logout'].map((step) => ({ step, status: 200, ms: 3, result: 'pass' })) },
};
const hostLine = (over = {}) => JSON.stringify({
  ok: true, command: 'drill', env: 'prod', project: 'lm-drill-prod-5bfd36fa', backupId: BACKUP_ID,
  backup: { id: BACKUP_ID, createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA },
  digest: DIGEST, restoreSeconds: 12.5, result: 'pass', failedStep: null, tool: toolOk, cleanedUp: true, backupCount: 14,
  startedAt: '2030-01-02T03:00:00+00:00', endedAt: '2030-01-02T03:05:00+00:00', ...over,
});
const failLine = (over = {}) => hostLine({ ok: false, reason: 'restore_failed', message: 'pg_restore 失敗', result: 'fail', failedStep: 'restore', tool: null, ...over });

describe('parseDrillResult', () => {
  test('結束碼 0 且 Smoke_Test 全部通過、drill 專案已銷毀 → 通過', () => {
    const d = parseDrillResult(0, `noise\n${hostLine()}\n`);
    expect(d).toMatchObject({ passed: true, code: 'passed', failedStep: null, backupId: BACKUP_ID, digest: DIGEST, restoreSeconds: 12.5, smokeResult: 'pass', cleanedUp: true, backupCount: 14 });
    expect(d.backup).toEqual({ id: BACKUP_ID, createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA });
    expect(d.smokeSteps.map((s) => s.step)).toEqual(['login-page', 'session', 'login', 'trips', 'logout']);
  });

  test('還原失敗：記錄失敗步驟與使用的備份識別碼，Smoke_Test 未執行', () => {
    const d = parseDrillResult(1, failLine());
    expect(d).toMatchObject({ passed: false, code: 'restore_failed', failedStep: 'restore', backupId: BACKUP_ID, smokeResult: 'not_run', restoreSeconds: 12.5 });
  });

  test('Smoke_Test 任一項未通過 → 未通過，failedStep 為 smoke', () => {
    const tool = { ...toolOk, ok: false, failedStep: 'smoke', smoke: { ok: false, steps: [{ step: 'trips', status: 200, ms: 4, result: 'fail', reason: 'fixture-missing' }] } };
    const d = parseDrillResult(1, failLine({ reason: 'smoke_failed', failedStep: 'smoke', tool }));
    expect(d).toMatchObject({ passed: false, failedStep: 'smoke', smokeResult: 'fail', backupId: BACKUP_ID });
    expect(d.smokeSteps[0]).toEqual({ step: 'trips', status: 200, ms: 4, result: 'fail', reason: 'fixture-missing' });
  });

  test('fail closed：結束碼非 0、result 非 pass、未銷毀、格式不符或非 prod drill 輸出皆不通過', () => {
    expect(parseDrillResult(1, hostLine()).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ result: 'fail' })).passed).toBe(false);
    const notCleaned = parseDrillResult(0, hostLine({ cleanedUp: false }));
    expect(notCleaned).toMatchObject({ passed: false, failedStep: 'cleanup' });
    expect(parseDrillResult(0, hostLine({ backupId: 'staging-20300102T000000Z-aeecb96' })).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ digest: 'sha256:abc' })).passed).toBe(false);
    expect(parseDrillResult(0, hostLine({ env: 'staging' }))).toMatchObject({ passed: false, code: 'invalid_output', backupId: null });
    expect(parseDrillResult(0, hostLine({ tool: { ...toolOk, smoke: { ok: true, steps: [] } } })).passed).toBe(false);
    expect(parseDrillResult(255, '')).toMatchObject({ passed: false, code: 'ssh_failed', failedStep: 'drill_tool' });
    expect(parseDrillResult(4, JSON.stringify({ ok: false, command: 'drill', env: 'prod', reason: 'drill_in_progress' }))).toMatchObject({ passed: false, code: 'drill_in_progress' });
  });

  test('不保留格式不符的步驟欄位（只留名稱、狀態碼、耗時、結果與失敗類別）', () => {
    const tool = { ...toolOk, ok: false, smoke: { ok: false, steps: [{ step: 'login', status: 401, ms: 3, result: 'fail', reason: 'status', body: 'secret', extra: 1 }, { step: 'Bad Step!', result: 'pass' }] } };
    const d = parseDrillResult(1, failLine({ failedStep: 'smoke', tool }));
    expect(d.smokeSteps).toEqual([{ step: 'login', status: 401, ms: 3, result: 'fail', reason: 'status' }]);
    expect(DRILL_STEPS).toContain(d.failedStep);
  });
});

describe('buildDrillRecord（Req 14.6、14.7）', () => {
  const base = { job: 'release/restore-drill', number: 7, url: 'https://jenkins.lan.example/job/7/', startedAt: '2030-01-02T03:00:00+00:00', endedAt: '2030-01-02T03:06:00+00:00', commit: COMMIT, buildImageDigest: DIGEST, by: 'timer' };

  test('通過：記錄備份識別碼、還原秒數與 Smoke_Test 結果，紀錄通過白名單驗證', () => {
    const r = buildDrillRecord({ ...base, drill: parseDrillResult(0, hostLine()), status: 'SUCCESS' });
    expect(validateRecord(r).ok).toBe(true);
    expect(r.backup).toEqual({ id: BACKUP_ID, env: 'production', createdAt: '2030-01-02T00:00:00+00:00', sizeBytes: 20, sha256: SHA });
    expect(r.deployments).toHaveLength(1);
    expect(r.deployments[0]).toMatchObject({ type: 'restore_drill', backupId: BACKUP_ID, restoreSeconds: 12.5, smokeResult: 'pass', result: 'pass', failedStep: NOT_APPLICABLE, backupsDeleted: 0, backupCount: 14, cleanedUp: true });
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
    expect(r.deployments[0]).toMatchObject({ result: 'fail', failedStep: 'restore', smokeResult: 'not_run', backupId: BACKUP_ID, backupsDeleted: 0 });
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
  });

  test('SSH：憑證只以 withCredentials 綁定、嚴格主機金鑰檢查；Build_Image 以 digest 引用（PLACEHOLDER fail closed）', () => {
    expect([...jfCode.matchAll(/credentialsId:/g)].length).toBe(3);
    expect(jfCode).toContain("sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')");
    expect(jfCode).toContain("file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')");
    for (const opt of ['-F /dev/null', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile="$LM_KNOWN_HOSTS"', 'GlobalKnownHostsFile=/dev/null', 'BatchMode=yes', 'IdentityAgent=none']) {
      expect(jf).toContain(opt);
    }
    expect(jf).not.toMatch(/StrictHostKeyChecking=(no|accept-new)|ssh-keyscan/);
    expect(/BUILD_IMAGE = '([^']+)'/.exec(jfCode)?.[1]).toMatch(/@sha256:<digest>$/);
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

describe('deploy/compose/drill.yaml 隔離（Req 14.6）', () => {
  test('專案名稱來自 LM_DRILL_PROJECT，只有一個 internal 網路，沒有發布任何連接埠', () => {
    expect(drillYaml.name).toMatch(/^\$\{LM_DRILL_PROJECT:\?/);
    expect(Object.keys(drillYaml.networks)).toEqual(['drill']);
    expect(drillYaml.networks.drill.internal).toBe(true);
    expect(drillYaml.networks.drill.external).toBeUndefined();
    for (const [name, svc] of Object.entries(drillYaml.services)) {
      expect({ name, ports: svc.ports, expose: svc.expose, network_mode: svc.network_mode }).toEqual({ name, ports: undefined, expose: undefined, network_mode: undefined });
      expect(svc.networks).toEqual(['drill']);
      expect(svc.read_only).toBe(true);
      expect(svc.cap_drop).toEqual(['ALL']);
      expect(svc.security_opt).toEqual(['no-new-privileges:true']);
      expect(svc.restart).toBe('no');
      expect(svc.labels['lm.drill']).toMatch(/^\$\{LM_DRILL_ENV/);
    }
  });

  test('Database 只使用匿名卷（沒有具名卷、bind mount 或 Production 的 pgdata）', () => {
    expect(drillYaml.volumes).toBeUndefined();
    expect(drillYaml.services.db.volumes).toEqual(['/var/lib/postgresql/data']);
    for (const svc of Object.values(drillYaml.services)) {
      for (const v of svc.volumes ?? []) expect(String(v)).not.toContain(':');
    }
    expect(drillYamlText).not.toMatch(/pgdata:|lm-(prod|staging)_|external:\s*true/);
  });

  test('秘密只來自 drill-*.env；不讀取正式環境的 app.env／db.env 或 <env>.env', () => {
    const files = Object.values(drillYaml.services).flatMap((s) => s.env_file ?? []);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^drill-(db|app|tool)\.env$/);
    const yamlCode = drillYamlText.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(yamlCode).not.toMatch(/(?<![-\w])(app|db|prod|staging)\.env\b/);
    expect(drillYaml.services.app.environment.CAMPING_OPENAI_API_KEY).toBe('');
    expect(drillYaml.services.app.environment.CAMPING_OPENAI_API_KEY_FILE).toBe('');
    expect(drillYaml.services.app.environment.CAMPING_ALLOWED_HOSTS).toBe('app');
    expect(drillYaml.services.tool.environment.CAMPING_DATABASE_NAME).toBe('lm_drill');
  });

  test('db 映像與 compose.yaml 相同；App／Migration_Runner／tool 皆使用 APP_IMAGE_DRILL', () => {
    expect(drillYaml.services.db.image).toBe(composeYaml.services.db.image);
    expect(drillYaml.services.db.healthcheck.test.join(' ')).toContain('-h 127.0.0.1');
    for (const s of ['app', 'migrate', 'tool']) expect(drillYaml.services[s].image).toMatch(/^\$\{APP_IMAGE_DRILL:\?/);
    expect(drillYaml.services.migrate.entrypoint).toEqual(['bun', '/app/server/migrate.js']);
    expect(drillYaml.services.tool.entrypoint).toEqual(['bun', '/app/tools/drill.js']);
    expect(drillYaml.services.tool.profiles).toEqual(['ops']);
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

  test('重算 sha256 後才還原；專案名稱與正式專案不同；所有 compose 呼叫都經 DRILL_CMD（drill.yaml）', () => {
    const verify = doDrill.indexOf('backup_checksum_mismatch');
    const restore = doDrill.indexOf('pg_restore');
    expect(verify).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(verify);
    expect(doDrill).toContain('[[ $DRILL_PROJECT =~ $DRILL_PROJECT_RE && $DRILL_PROJECT != "lm-$ENVN" ]]');
    expect(lmDeploy).toContain("readonly DRILL_PROJECT_RE='^lm-drill-(staging|prod)-[0-9a-f]{8}$'");
    expect(doDrill).toContain('-f "$ENV_DIR/drill.yaml"');
    expect(doDrill).not.toContain('COMPOSE_CMD');
    expect(doDrill).not.toContain('compose.yaml');
    expect(doDrill).toContain('pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U lm_drill -d lm_drill');
  });

  test('任何結束路徑都 down -v；秘密只寫入 0600 暫存檔，不輸出', () => {
    expect(shellFunction(lmDeploy, 'drill_down')).toContain('down -v --remove-orphans');
    expect(shellFunction(lmDeploy, 'cleanup')).toMatch(/DRILL_UP == 1 \]\]; then drill_down/);
    expect(shellFunction(lmDeploy, 'drill_fail')).toMatch(/drill_down[\s\S]*drill_remove_dir[\s\S]*die/);
    for (const sig of ["trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM"]) expect(doDrill).toContain(sig);
    const secrets = shellFunction(lmDeploy, 'drill_write_secrets');
    expect(secrets).toContain('chmod 0600');
    expect(secrets).not.toMatch(/emit|log |printf '[^']*'\s*"\$(dbpw|pw|token)"\s*$/m);
    expect(secrets).not.toMatch(/>&2|>>"\$DRILL_LOG"/);
    // docker／pg_restore 輸出只進 0600 的 drill-last.log（tool 的 stdout 進暫存檔），不進 stdout／stderr。
    expect(doDrill).not.toContain('>&2');
    expect([...doDrill.matchAll(/>>"\$DRILL_LOG" 2>&1/g)].length).toBe(4);
    expect(doDrill).toContain('tool run >"$out" 2>>"$DRILL_LOG"');
    expect(doDrill).toContain('chmod 0600 -- "$DRILL_LOG"');
  });

  test('tool 輸出只在符合嚴格字元集時才嵌入 JSON', () => {
    // POSIX ERE 的 `[]...]` 在 JS 需寫成 `[\]...]`。
    const re = new RegExp(/readonly DRILL_TOOL_JSON_RE='([^']+)'/.exec(lmDeploy)[1].replace('[][', '[\\][') );
    expect(re.test(JSON.stringify(toolOk))).toBe(true);
    expect(re.test('{"a":"b c"}')).toBe(false);
    expect(re.test('{"a":"\\u0000"}')).toBe(false);
    expect(re.test('{"a":"x"}\n{"b":1}')).toBe(false);
    expect(lmDeploy).toContain(`[[ $DRILL_TOOL != '{"ok":true,"failedStep":null,'* ]]`);
  });
});

describe('安裝與打包', () => {
  test('install.sh 安裝 drill.yaml；build-server 打包 /app/tools/drill.js', () => {
    const install = read('deploy/host/install.sh');
    expect(install).toContain('SRC_DRILL="$DEPLOY_DIR/compose/drill.yaml"');
    expect(install).toContain('install_atomic "$SRC_DRILL" "$d/drill.yaml" 0644');
    expect(read('scripts/build-server.mjs')).toContain("{ entry: 'scripts/drill.mjs', dir: 'tools', name: 'drill.js' }");
  });
});
