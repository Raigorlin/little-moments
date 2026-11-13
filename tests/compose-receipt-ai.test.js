// Production 收據 AI（OpenAI）的金鑰檔掛載（jenkins-cicd-deploy tasks 27.2；design.md Components §25.4、§25.5、§25.8；
// Requirements 15.6、15.7、15.9）。
//
// 靜態檢查 deploy/compose/compose.yaml 的 x-openai-key 掛載與 deploy/bin/lm-deploy 的變數清單；lm-deploy 的行為
// （金鑰檔寫入、拒絕與 build_compose 的檢查）由 deploy/tests/lm-deploy.bats 涵蓋。與 tests/ci-lint.test.js 分開，
// 以便和 Pipeline 的任務（27.1）並行修改。本檔不含任何金鑰或符合金鑰格式的字串。
import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');

const TARGET = '/run/secrets/openai-api-key';
const MOUNT = Object.freeze({
  type: 'bind',
  source: '${LM_OPENAI_KEY_SOURCE:-/dev/null}',
  target: TARGET,
  read_only: true,
  bind: { create_host_path: false },
});

const composeText = read('deploy/compose/compose.yaml');
const compose = YAML.parse(composeText);
const lmDeploy = read('deploy/bin/lm-deploy');

/** volumes 項目的容器內路徑（短語法 `src:dst[:mode]` 或長語法 `target`）。 */
function volumeTarget(v) {
  if (v && typeof v === 'object') return v.target;
  const parts = String(v).split(':');
  return parts.length >= 2 ? parts[1] : parts[0];
}

describe('compose.yaml：收據 AI 金鑰檔只掛載到 app-blue／app-green', () => {
  test('x-openai-key 錨點為長語法唯讀 bind，來源預設 /dev/null，不建立主機路徑', () => {
    expect(compose['x-openai-key']).toEqual(MOUNT);
  });

  for (const svc of ['app-blue', 'app-green']) {
    test(`${svc} 恰有一個符合規格的金鑰檔掛載`, () => {
      const volumes = compose.services[svc].volumes ?? [];
      const mounts = volumes.filter((v) => volumeTarget(v) === TARGET);
      expect(mounts).toEqual([MOUNT]);
      // 其他掛載不得引用金鑰檔或其來源變數。
      for (const v of volumes.filter((x) => volumeTarget(x) !== TARGET)) expect(JSON.stringify(v)).not.toMatch(/openai/i);
      // 原始文字以錨點引用（不是另一份可能不同步的複本）。
      expect(composeText).toMatch(new RegExp(`^  ${svc}:\\n(?:    .*\\n)*?    volumes: \\[\\*openai_key\\]$`, 'm'));
    });
  }

  for (const svc of ['migrate', 'proxy', 'db']) {
    test(`${svc} 沒有金鑰檔掛載`, () => {
      const def = compose.services[svc];
      expect(def).toBeDefined();
      for (const v of def.volumes ?? []) {
        expect(volumeTarget(v)).not.toBe(TARGET);
        expect(JSON.stringify(v)).not.toMatch(/openai/i);
      }
    });
  }

  test('x-app 沒有 volumes（migrate 經 <<: *app 不會繼承掛載）', () => {
    expect(compose['x-app'].volumes).toBeUndefined();
  });

  test('x-app.environment：CAMPING_OPENAI_API_KEY 仍為空字串，金鑰檔路徑由 lm-deploy 傳入', () => {
    const env = compose['x-app'].environment;
    expect(env.CAMPING_OPENAI_API_KEY).toBe('');
    expect(env.CAMPING_OPENAI_API_KEY_FILE).toBe('${CAMPING_OPENAI_API_KEY_FILE:-}');
    for (const svc of ['app-blue', 'app-green', 'migrate']) {
      expect(compose.services[svc].environment.CAMPING_OPENAI_API_KEY).toBe('');
    }
  });
});

describe('lm-deploy：收據 AI 的變數清單', () => {
  test('啟動時的 unset 清單含 LM_OPENAI_KEY_SOURCE 與所有 CAMPING_OPENAI_*', () => {
    const m = /^unset ((?:[^\n]*\\\n)*[^\n]*)$/m.exec(lmDeploy);
    expect(m).not.toBeNull();
    const names = m[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
    for (const n of ['LM_OPENAI_KEY_SOURCE', 'CAMPING_OPENAI_API_KEY', 'CAMPING_OPENAI_API_KEY_FILE', 'CAMPING_OPENAI_MODEL_ID',
      'CAMPING_OPENAI_IMAGE_DETAIL', 'CAMPING_OPENAI_MAX_COMPLETION_TOKENS']) {
      expect(names).toContain(n);
    }
  });

  test('APP_ENV_KEYS 不含控制鍵 LM_RECEIPT_AI 與 LM_OPENAI_API_KEY', () => {
    const m = /^readonly APP_ENV_KEYS="([^"]*)"$/m.exec(lmDeploy);
    expect(m).not.toBeNull();
    const keys = m[1].trim().split(/\s+/);
    expect(keys).toEqual(['CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_SETUP_TOKEN']);
    expect(keys).not.toContain('LM_RECEIPT_AI');
    expect(keys).not.toContain('LM_OPENAI_API_KEY');
  });

  test('build_compose 以 env 傳入 LM_OPENAI_KEY_SOURCE 與 CAMPING_OPENAI_API_KEY_FILE（只有路徑）', () => {
    const start = lmDeploy.indexOf('build_compose() {');
    const body = lmDeploy.slice(start, lmDeploy.indexOf('\n}\n', start));
    expect(body).toContain('openai_key_state');
    expect(body).toContain('"LM_OPENAI_KEY_SOURCE=$OPENAI_SOURCE" "CAMPING_OPENAI_API_KEY_FILE=$OPENAI_FILE_ENV"');
    expect(lmDeploy).toContain("readonly OPENAI_KEY_TARGET=/run/secrets/openai-api-key");
    expect(lmDeploy).toContain("readonly OPENAI_KEY_RE='^sk-[A-Za-z0-9_-]{20,500}$'");
  });
});

// ---------------------------------------------------------------------------------------------
// docker compose config（有 Docker 時）：兩種 LM_OPENAI_KEY_SOURCE 的展開結果。
// ---------------------------------------------------------------------------------------------

function dockerCompose() {
  const docker = Bun.which('docker');
  if (!docker) return null;
  const r = Bun.spawnSync([docker, 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode === 0 ? docker : null;
}
const docker = dockerCompose();

function composeConfig(extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-compose-ai-'));
  try {
    writeFileSync(join(dir, 'compose.yaml'), composeText);
    writeFileSync(join(dir, 'app.env'), '');
    writeFileSync(join(dir, 'db.env'), '');
    const img = `registry.example.test/little-moments@sha256:${'1'.repeat(64)}`;
    const env = {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, LM_ENV: 'staging', APP_IMAGE_BLUE: img, APP_IMAGE_GREEN: img,
      APP_IMAGE_NEW: img, ALLOWED_HOSTS: 'lm.example.test', PROXY_IP: '172.30.20.2', LAN_IP: '192.0.2.10', LM_PUBLIC_PORT: '8081',
      LM_HEALTH_HOST: 'lm.example.test', APP_SUBNET: '172.30.20.0/24', ...extraEnv,
    };
    const r = Bun.spawnSync([docker, 'compose', '--project-directory', dir, '-f', join(dir, 'compose.yaml'),
      '--profile', 'blue', '--profile', 'green', '--profile', 'ops', 'config', '--format', 'json'], { env, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`docker compose config 失敗：${r.stderr.toString()}`);
    return { config: JSON.parse(r.stdout.toString()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const expandedMount = (svc) => (svc.volumes ?? []).filter((v) => v.target === TARGET);

describe('docker compose config 的展開結果', () => {
  test.skipIf(!docker)(docker ? 'LM_OPENAI_KEY_SOURCE 未設定時為 /dev/null；設定時為該檔；migrate／proxy／db 沒有掛載'
    : '（略過：沒有 docker compose，無法以 docker compose config 檢查展開結果）', () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'lm-compose-key-'));
    try {
      const keyFile = join(keyDir, 'openai-api-key');
      writeFileSync(keyFile, 'placeholder\n');
      for (const [extra, source] of [[{}, '/dev/null'], [{ LM_OPENAI_KEY_SOURCE: keyFile }, keyFile]]) {
        const { config } = composeConfig(extra);
        for (const svc of ['app-blue', 'app-green']) {
          const mounts = expandedMount(config.services[svc]);
          expect(mounts.length).toBe(1);
          expect(mounts[0]).toMatchObject({ type: 'bind', source, target: TARGET, read_only: true, bind: { create_host_path: false } });
        }
        for (const svc of ['migrate', 'proxy', 'db']) expect(expandedMount(config.services[svc])).toEqual([]);
      }
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  }, 60_000);
});
