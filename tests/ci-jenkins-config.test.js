// ci/jenkins/casc.yaml、local-security.yaml 與 jobs.groovy 的靜態檢查（Requirement 1.1、2.1、2.4–2.8、15.1、18.9、19.3、20.12、21.3–21.5、21.12；tasks 13.9、19.1、19.2）。
//
// 本機沒有 Jenkins：這裡只驗證設定的結構與一致性（YAML 可解析、權限、憑證 ID 與資料夾範圍、保留天數、cron、
// 信任策略、Tag build strategy、無秘密字面值），不能取代在 controller 上實際套用 Configuration as Code 與 Job DSL。
import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const cascText = read('ci/jenkins/casc.yaml');
const casc = YAML.parse(cascText);
const localSecText = read('ci/jenkins/local-security.yaml');
const localSec = YAML.parse(localSecText);
const jobsText = read('ci/jenkins/jobs.groovy');
const readme = read('ci/jenkins/README.md');

const FORBIDDEN = ['Run/Delete', 'Run/Update', 'Job/Configure', 'Run/Replay'];
const ADMIN_USER = 'jacklin';
const RETENTION_USER = 'lm-retention-bot';
const JENKINS_URL = 'https://jenkins.our-littlemoments.com/';

// 部署、簽章、資料庫、Setup_Token、smoke、OpenAI 金鑰與 Jenkins API 憑證：只能在 release/（Req 2.4、15.8）。
const RELEASE_ONLY = [
  'lm-cosign-key', 'lm-cosign-passphrase', 'lm-cosign-pub', 'lm-deploy-known-hosts',
  'lm-ssh-staging', 'lm-staging-db', 'lm-staging-setup-token', 'lm-staging-smoke',
  'lm-ssh-prod', 'lm-prod-db', 'lm-prod-setup-token', 'lm-prod-smoke', 'lm-prod-openai-api-key',
  'lm-jenkins-api-readonly', 'lm-jenkins-api-retention',
];

/** 移除 Groovy 的 // 註解行（只處理整行註解，足以用於結構比對）。 */
const codeOnly = (text) => text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** jobs.groovy 中 `// BEGIN credentials <folder>` 與 `// END credentials <folder>` 之間的憑證規格。 */
function folderCredentials(text) {
  const out = {};
  for (const m of text.matchAll(/\/\/ BEGIN credentials (\w+)\n([\s\S]*?)\/\/ END credentials \1\n/g)) {
    out[m[1]] = [...m[2].matchAll(/\[id: '([^']+)', type: '([^']+)'/g)].map((x) => ({ id: x[1], type: x[2] }));
  }
  return out;
}
const FOLDERS = folderCredentials(jobsText);
const idsOf = (folder) => (FOLDERS[folder] ?? []).map((c) => c.id);

/** Jenkinsfile 中 `LM_*_CREDENTIALS = '<id>'` 與 `<binding>(credentialsId: env.LM_*_CREDENTIALS` 的對應。 */
function credentialUsage(text) {
  const code = codeOnly(text);
  const vars = Object.fromEntries([...code.matchAll(/(LM_\w+_CREDENTIALS)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  const bindings = [...code.matchAll(/(\w+)\(\s*credentialsId:\s*env\.(LM_\w+_CREDENTIALS)/g)].map((m) => ({ binding: m[1], id: vars[m[2]], variable: m[2] }));
  const literal = [...code.matchAll(/credentialsId:\s*'([^']+)'/g)].map((m) => m[1]);
  return { vars, bindings, ids: [...new Set([...Object.values(vars), ...literal])] };
}

const pipelineDir = resolve(root, 'ci/jenkins/pipelines');
const pipelineFiles = readdirSync(pipelineDir).filter((f) => f.endsWith('.Jenkinsfile'));
const JENKINSFILES = {
  Jenkinsfile: read('Jenkinsfile'),
  ...Object.fromEntries(pipelineFiles.map((f) => [`ci/jenkins/pipelines/${f}`, read(`ci/jenkins/pipelines/${f}`)])),
};
// 每個 Jenkinsfile 由哪個資料夾的 Job 執行（Job 名稱與 jobs.groovy 一致）。
const FOLDER_OF = {
  'ci/jenkins/pipelines/rollback.Jenkinsfile': 'release',
  'ci/jenkins/pipelines/restore-drill.Jenkinsfile': 'release',
  'ci/jenkins/pipelines/digest-lookup.Jenkinsfile': 'release',
  'ci/jenkins/pipelines/build-image.Jenkinsfile': 'infra',
};

/** jobs.groovy 中每個 permissions([...]) 與其主體、所在的 folder/job 宣告。 */
function permissionGrants(text) {
  const code = codeOnly(text);
  const decls = [...code.matchAll(/^(folder|multibranchPipelineJob|pipelineJob)\('([^']+)'\)/gm)].map((m) => ({ at: m.index, item: m[2] }));
  return [...code.matchAll(/(user|group)\s*\{\s*name\(([A-Z_]+|'[^']+')\)\s*permissions\(\[([^\]]*)\]\)/g)].map((m) => {
    const owner = decls.filter((d) => d.at < m.index).at(-1);
    const nameExpr = m[2];
    const name = nameExpr.startsWith("'") ? nameExpr.slice(1, -1) : groovyConst(text, nameExpr);
    return { kind: m[1], name, item: owner?.item, permissions: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]) };
  });
}

/** `@Field final String NAME = '<value>'` 的值。 */
function groovyConst(text, name) {
  const m = new RegExp(`@Field final (?:String|int) ${name} = '?([^'\\n]*?)'?(?:\\s*//.*)?$`, 'm').exec(text);
  if (!m) throw new Error(`jobs.groovy 沒有常數 ${name}`);
  return m[1];
}

/** 取出 `<kind>('<name>') { ... }` 的內容（以大括號配對；jobs.groovy 的字串不含大括號）。 */
function block(text, kind, name) {
  const start = text.indexOf(`${kind}('${name}') {`);
  if (start < 0) throw new Error(`jobs.groovy 沒有 ${kind}('${name}')`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${kind}('${name}') 大括號不成對`);
}

describe('檔案格式', () => {
  for (const p of ['ci/jenkins/casc.yaml', 'ci/jenkins/local-security.yaml', 'ci/jenkins/jobs.groovy', 'ci/jenkins/README.md']) {
    test(`${p}：UTF-8 無 BOM、LF 換行`, () => {
      const bytes = readFileSync(resolve(root, p));
      expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf).toBe(false);
      expect(bytes.includes(0x0d)).toBe(false);
    });
  }

  test('jobs.groovy 大括號、方括號與小括號成對', () => {
    const stripped = codeOnly(jobsText).replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\/\[\\r\\n\]\+\$\//g, "''");
    for (const [open, close] of [['{', '}'], ['[', ']'], ['(', ')']]) {
      let depth = 0;
      for (const ch of stripped) {
        if (ch === open) depth++;
        if (ch === close) depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    }
  });
});

describe('casc.yaml：Matrix Authorization（Req 21.12）', () => {
  const entries = casc.jenkins.authorizationStrategy.projectMatrix.entries;
  const flat = entries.map((e) => {
    const kind = Object.keys(e)[0];
    return { kind, name: e[kind].name, permissions: e[kind].permissions ?? [] };
  });

  const isAdmin = (e) => e.kind === 'user' && e.name === ADMIN_USER;

  test('只有使用者 jacklin 有 Overall/Administer', () => {
    const admins = flat.filter((e) => e.permissions.includes('Overall/Administer'));
    expect(admins).toEqual([{ kind: 'user', name: ADMIN_USER, permissions: ['Overall/Administer'] }]);
    expect(flat.some((e) => e.name === 'lm-jenkins-admins')).toBe(false);
  });

  test('非管理員沒有 Run/Delete、Run/Update、Job/Configure、Run/Replay，也沒有憑證與 Lockable Resources 權限', () => {
    const others = flat.filter((x) => !isAdmin(x));
    expect(others.length).toBe(flat.length - 1);
    for (const e of others) {
      for (const p of e.permissions) {
        expect(FORBIDDEN).not.toContain(p);
        expect(p.startsWith('Credentials/')).toBe(false);
        expect(p.startsWith('Lockable Resources/')).toBe(false);
        expect(['Job/Delete', 'Job/Create', 'Job/Move', 'Overall/Manage', 'Overall/SystemRead']).not.toContain(p);
      }
    }
    expect(flat.some((e) => e.name === 'anonymous')).toBe(false);
  });

  test('Release_Approver 群組存在，且與 jobs.groovy 使用的群組名稱一致', () => {
    const names = flat.map((e) => e.name);
    expect(names).toContain('lm-release-approvers');
    for (const g of ['GROUP_DEVELOPERS', 'GROUP_RELEASE_APPROVERS', 'GROUP_AUDITORS']) {
      expect(names).toContain(groovyConst(jobsText, g));
    }
    expect(groovyConst(jobsText, 'GROUP_RELEASE_APPROVERS')).toBe('lm-release-approvers');
  });

  test('保留供外部 security realm 使用的群組項目；管理員是本機使用者資料庫的帳號', () => {
    const groups = flat.filter((e) => e.kind === 'group').map((e) => e.name).sort();
    expect(groups).toEqual(['authenticated', 'lm-auditors', 'lm-developers', 'lm-release-approvers']);
    expect(localSec.jenkins.securityRealm.local.users.map((u) => u.id)).toContain(ADMIN_USER);
  });
});

describe('casc.yaml：實際部署值與移除的設定（tasks 19.2）', () => {
  test('沒有 crumbIssuer（使用 core 預設的 CSRF issuer）與 remotingSecurity', () => {
    expect('crumbIssuer' in casc.jenkins).toBe(false);
    expect('remotingSecurity' in casc.jenkins).toBe(false);
    expect(cascText).not.toMatch(/^\s*(crumbIssuer|remotingSecurity|excludeClientIPFromCrumb):/m);
  });

  test('location.url 與 hookUrl 為實際主機名稱，沒有 PLACEHOLDER', () => {
    expect(casc.unclassified.location.url).toBe(JENKINS_URL);
    expect(casc.unclassified.gitHubPluginConfig.hookUrl).toBe(`${JENKINS_URL}github-webhook/`);
    expect(cascText).not.toContain('PLACEHOLDER');
    expect(cascText).not.toContain('lan.example');
  });
});

describe('local-security.yaml：本機使用者資料庫（Req 2.1、21.12）', () => {
  const realm = localSec?.jenkins?.securityRealm?.local;

  test('是有效的 YAML，只定義 jenkins.securityRealm.local，且不開放自行註冊', () => {
    expect(Object.keys(localSec)).toEqual(['jenkins']);
    expect(Object.keys(localSec.jenkins)).toEqual(['securityRealm']);
    expect(realm.allowsSignup).toBe(false);
  });

  test('使用者為 jacklin、lm-retention-bot、lm-api-readonly；每個密碼都只是 ${VAR}', () => {
    expect(realm.users.map((u) => u.id)).toEqual([ADMIN_USER, RETENTION_USER, 'lm-api-readonly']);
    const vars = realm.users.map((u) => u.password);
    expect(vars).toEqual(['${JENKINS_ADMIN_PASSWORD}', '${RETENTION_BOT_PASSWORD}', '${API_READONLY_PASSWORD}']);
    for (const u of realm.users) {
      expect(Object.keys(u).sort()).toEqual(['id', 'password']);
      expect(u.password).toMatch(/^\$\{[A-Z][A-Z0-9_]*\}$/);
    }
  });

  test('jobs.groovy 授權的使用者存在於本機使用者資料庫', () => {
    expect(realm.users.map((u) => u.id)).toContain(groovyConst(jobsText, 'USER_RETENTION_BOT'));
  });
});

describe('casc.yaml：webhook secret、系統憑證與 Lockable Resources', () => {
  const system = casc.credentials.system.domainCredentials.flatMap((d) => d.credentials);

  test('系統憑證只有 SYSTEM 範圍（Job 無法取得），值只以 ${VAR} 引用秘密來源', () => {
    expect(system.length).toBeGreaterThan(0);
    for (const c of system) {
      const [type] = Object.keys(c);
      const body = c[type];
      expect(body.scope).toBe('SYSTEM');
      for (const key of ['secret', 'password', 'privateKey', 'secretBytes', 'passphrase']) {
        if (key in body) expect(body[key]).toMatch(/^\$\{[A-Z][A-Z0-9_]*\}$/);
      }
    }
  });

  test('GitHub webhook 以 SYSTEM 範圍的 secret 驗證 HMAC-SHA256（Req 2.1）', () => {
    const hooks = casc.unclassified.gitHubPluginConfig.hookSecretConfigs;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].signatureAlgorithm).toBe('SHA256');
    const secret = system.find((c) => c.string?.id === hooks[0].credentialsId);
    expect(secret?.string.secret).toBe('${GITHUB_WEBHOOK_SECRET}');
  });

  test('Lockable Resources lm-staging 與 lm-prod 存在，且涵蓋所有 Jenkinsfile 的 lock（Req 18.9、20.12）', () => {
    const declared = casc.unclassified.lockableResourcesManager.declaredResources.map((r) => r.name);
    expect(declared).toEqual(expect.arrayContaining(['lm-staging', 'lm-prod']));
    const used = new Set();
    for (const text of Object.values(JENKINSFILES)) {
      for (const m of codeOnly(text).matchAll(/lock\(\s*(?:resource:\s*)?'([^']+)'/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual(['lm-prod', 'lm-staging']);
    for (const r of used) expect(declared).toContain(r);
  });

  test('載入 jobs.groovy，controller 不執行建置', () => {
    expect(casc.jobs.map((j) => j.file)).toEqual(['${LM_CASC_DIR:-/var/jenkins_home/casc}/jobs.groovy']);
    expect(casc.jenkins.numExecutors).toBe(0);
  });
});

describe('casc.yaml：agent 標籤與 Job Restrictions（Req 2.6）', () => {
  const nodes = casc.jenkins.nodes.map((n) => n.permanent);
  const byLabel = (label) => nodes.filter((n) => n.labelString.split(/\s+/).includes(label));
  const restriction = (n) => new RegExp(n.nodeProperties[0].jobRestrictionProperty.jobRestriction.regexNameRestriction.regexExpression);

  test('Jenkinsfile 使用的 agent 標籤都有對應的 agent', () => {
    const labels = new Set();
    for (const text of Object.values(JENKINSFILES)) {
      for (const m of codeOnly(text).matchAll(/agent\s*\{\s*label\s+(['"])(.*?)\1\s*\}/g)) {
        for (const l of m[2].matchAll(/lm-[a-z]+/g)) labels.add(l[0]);
      }
    }
    expect([...labels].sort()).toEqual(['lm-trusted', 'lm-untrusted']);
    for (const l of labels) expect(byLabel(l).length).toBeGreaterThan(0);
  });

  test('Untrusted Agent 只接受 ci/ 的建置；Trusted Agent 只接受 release/ 與 infra/', () => {
    for (const n of byLabel('lm-untrusted')) {
      expect(n.mode).toBe('EXCLUSIVE');
      const re = restriction(n);
      expect(re.test('ci/little-moments/PR-12-merge')).toBe(true);
      expect(re.test('release/little-moments/main')).toBe(false);
      expect(re.test('infra/build-image')).toBe(false);
    }
    for (const n of byLabel('lm-trusted')) {
      expect(n.mode).toBe('EXCLUSIVE');
      const re = restriction(n);
      for (const job of ['release/little-moments/main', 'release/little-moments/v1.2.3', 'release/rollback', 'infra/build-image']) {
        expect(re.test(job)).toBe(true);
      }
      expect(re.test('ci/little-moments/PR-12-head')).toBe(false);
      expect(re.test('ci/little-moments/feature-x')).toBe(false);
    }
  });

  test('兩個 agent 在同一主機上使用不同的工作目錄（remoteFS）', () => {
    const fs = Object.fromEntries(nodes.map((n) => [n.name, n.remoteFS]));
    expect(fs).toEqual({ 'lm-trusted-1': '/var/lib/jenkins-agent', 'lm-untrusted-1': '/var/lib/jenkins-untrusted' });
    expect(new Set(Object.values(fs)).size).toBe(nodes.length);
  });
});

describe('jobs.groovy：資料夾範圍憑證（Req 2.4、2.5、15.1）', () => {
  test('三個資料夾都有憑證規格；ci/ 只有 GitHub App 與唯讀 Registry 拉取', () => {
    expect(Object.keys(FOLDERS).sort()).toEqual(['ci', 'infra', 'release']);
    expect(idsOf('ci').sort()).toEqual(['lm-github-app', 'lm-registry-pull']);
  });

  test('部署、簽章、資料庫、Setup_Token、smoke 與 Jenkins API 憑證只定義於 release/', () => {
    for (const id of RELEASE_ONLY) {
      expect(idsOf('release')).toContain(id);
      expect(idsOf('ci')).not.toContain(id);
      expect(idsOf('infra')).not.toContain(id);
    }
    expect(idsOf('ci')).not.toContain('lm-registry-push');
  });

  test('每個資料夾內憑證 ID 不重複', () => {
    for (const folder of Object.keys(FOLDERS)) {
      expect(new Set(idsOf(folder)).size).toBe(idsOf(folder).length);
    }
  });

  test('根目錄 Jenkinsfile 引用的每個憑證都定義於 release/；ci/ 也有的只有 GitHub App 與拉取帳號', () => {
    const { ids } = credentialUsage(JENKINSFILES.Jenkinsfile);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(idsOf('release')).toContain(id);
    expect(ids.filter((id) => idsOf('ci').includes(id)).sort()).toEqual(['lm-github-app', 'lm-registry-pull']);
  });

  test('ci/jenkins/pipelines/*.Jenkinsfile 引用的憑證都定義於其 Job 所在的資料夾', () => {
    for (const [file, folder] of Object.entries(FOLDER_OF)) {
      if (!JENKINSFILES[file]) continue;   // build-image.Jenkinsfile 由另一個任務建立
      const { ids } = credentialUsage(JENKINSFILES[file]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(idsOf(folder)).toContain(id);
    }
    // 所有 pipelines 檔案都必須有對應的 Job。
    for (const f of pipelineFiles) expect(Object.keys(FOLDER_OF)).toContain(`ci/jenkins/pipelines/${f}`);
  });

  test('憑證類型符合 Jenkinsfile 的 withCredentials 綁定', () => {
    const expected = {
      usernamePassword: ['usernamePassword'],
      string: ['string'],
      file: ['file'],
      sshUserPrivateKey: ['sshKey'],
      gitUsernamePassword: ['gitHubApp', 'usernamePassword'],
    };
    let checked = 0;
    for (const [file, text] of Object.entries(JENKINSFILES)) {
      const folder = FOLDER_OF[file] ?? 'release';
      for (const b of credentialUsage(text).bindings) {
        expect(b.id).toBeDefined();
        const spec = FOLDERS[folder].find((c) => c.id === b.id);
        expect(spec).toBeDefined();
        expect(expected[b.binding]).toContain(spec.type);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('Multibranch 與 Pipeline Job 的 SCM 憑證存在於對應資料夾', () => {
    for (const folder of ['ci', 'release', 'infra']) expect(idsOf(folder)).toContain('lm-github-app');
    expect(codeOnly(jobsText)).toContain("credentials('lm-github-app')");
    expect([...codeOnly(jobsText).matchAll(/credentialsId\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['lm-github-app', 'lm-github-app']);
  });

  test('秘密值只在 seed 時自秘密來源讀取，缺少時 fail closed', () => {
    expect(jobsText).toContain("System.getenv('SECRETS') ?: '/run/secrets'");
    expect(jobsText).toMatch(/if \(!missingSecrets\.isEmpty\(\)\) \{\s*throw new IllegalStateException/);
    // DSL 的憑證 closure 只引用預先讀出的區域變數。
    const credBlock = jobsText.slice(jobsText.indexOf('Closure folderCredentials('), jobsText.indexOf('Closure retention('));
    expect(credBlock).not.toMatch(/secretLine\(|secretBlock\(|secretBytes\(folderName/);
    expect(credBlock.match(/scope\('GLOBAL'\)/g)).toHaveLength(5);
  });

  // tasks 19.1：在實際的 Jenkins LTS controller 上載入 jobs.groovy 驗證過的 Job DSL 名稱與秘密處理。
  const credCode = codeOnly(jobsText.slice(jobsText.indexOf('Closure folderCredentials('), jobsText.indexOf('/** Multibranch 的分支保留屬性')));

  test('憑證使用 Job DSL 接受的方法名稱，不使用 CasC 的 symbol', () => {
    for (const name of ['usernamePassword', 'stringCredentialsImpl', 'fileCredentialsImpl', 'basicSSHUserPrivateKey', 'directEntryPrivateKeySource', 'gitHubAppCredentials']) {
      expect(credCode).toMatch(new RegExp(`^\\s*${name} \\{$`, 'm'));
    }
    for (const symbol of ['gitHubApp', 'string', 'file', 'directEntry']) {
      expect(codeOnly(jobsText)).not.toMatch(new RegExp(`(^|[^\\w.])${symbol} \\{`, 'm'));
    }
    // FileCredentialsImpl 的 file（FileItem）為必要參數；內容由 secretBytes 提供。
    expect(credCode).toMatch(/fileCredentialsImpl \{\s*scope\('GLOBAL'\)\s*id\(r\.id\)\s*description\(r\.description\)\s*file\(null\)\s*fileName\(r\.fileName\)\s*secretBytes\(r\.bytes\)\s*\}/);
    // Secret 型別的參數以 hudson.util.Secret.fromString 傳入。
    expect(credCode).toContain('secret(hudson.util.Secret.fromString(r.secret))');
    expect(credCode.match(/privateKey\(hudson\.util\.Secret\.fromString\(r\.key\)\)/g)).toHaveLength(2);
    expect(credCode).not.toMatch(/privateKey\(r\.key\)|secret\(r\.secret\)/);
    expect(credCode).toMatch(/usernamePassword \{[^}]*password\(r\.password\)\s*\}/);
    expect(credCode).toMatch(/basicSSHUserPrivateKey \{[^}]*passphrase\(''\)/);
  });

  test('GitHub App 憑證不設定 owner，也不需要 <id>.owner 秘密檔', () => {
    expect(codeOnly(jobsText)).not.toMatch(/\bowner\(/);
    expect(jobsText).not.toContain('.owner');
    expect(jobsText).toContain(`case 'gitHubApp': return ["\${c.id}.app-id", "\${c.id}.key"]*.toString()`);
    expect(credCode).toMatch(/gitHubAppCredentials \{\s*scope\('GLOBAL'\)\s*id\(r\.id\)\s*description\(r\.description\)\s*appID\(r\.appId\)\s*privateKey\(hudson\.util\.Secret\.fromString\(r\.key\)\)\s*\}/);
  });

  test('建立憑證的例外只含「資料夾/憑證 ID（類型）」與例外類別名稱，不附原訊息或 cause', () => {
    // 每個憑證各自包裝。
    expect(credCode).toMatch(/for \(Map r in resolved\) \{\s*try \{\s*if \(r\.type == 'usernamePassword'\)/);
    expect(credCode).toMatch(/\} catch \(Throwable e\) \{\s*sanitized = new IllegalStateException\("無法建立資料夾憑證：\$\{folderName\}\/\$\{r\.id\}（\$\{r\.type\}，\$\{e\.getClass\(\)\.getName\(\)\}）"\.toString\(\)\)\s*throw sanitized\s*\}/);
    // 整個 folderCredentialsProperty 也包裝；已改寫的例外原樣拋出，其他例外只列出資料夾。
    expect(credCode).toMatch(/return \{\s*try \{\s*folderCredentialsProperty \{/);
    expect(credCode).toMatch(/\} catch \(Throwable e\) \{\s*if \(sanitized != null && e\.is\(sanitized\)\) \{\s*throw e\s*\}\s*throw new IllegalStateException\("無法建立資料夾憑證：\$\{folderName\}（folderCredentialsProperty，\$\{e\.getClass\(\)\.getName\(\)\}）"\.toString\(\)\)\s*\}\s*\}\s*\}$/m);
    expect(credCode.match(/catch \(Throwable e\)/g)).toHaveLength(2);
    // 所有 IllegalStateException 只有一個字串參數（沒有 cause）；不讀取原例外的訊息或堆疊。
    const isEs = [...credCode.matchAll(/new IllegalStateException\((.*)\)$/gm)].map((m) => m[1]);
    expect(isEs).toHaveLength(2);
    for (const arg of isEs) expect(arg).toMatch(/^"[^"]*"\.toString\(\)$/);
    expect(jobsText).not.toMatch(/getMessage|getLocalizedMessage|\be\.message\b|initCause|addSuppressed|printStackTrace|getStackTrace|getCause/);
    expect(credCode).not.toMatch(/\$\{e\}|\be\.toString\(\)|\+\s*e\b/);
  });

  test('GITHUB_OWNER 與 GITHUB_REPO 為實際值，不再有 PLACEHOLDER', () => {
    expect(groovyConst(jobsText, 'GITHUB_OWNER')).toBe('Raigorlin');
    expect(groovyConst(jobsText, 'GITHUB_REPO')).toBe('little-moments');
    expect(jobsText).toMatch(/^@Field final String GITHUB_OWNER = 'Raigorlin'$/m);
    expect(jobsText).toMatch(/^@Field final String GITHUB_REPO = 'little-moments'$/m);
    expect(jobsText).not.toContain('PLACEHOLDER');
    expect(jobsText).not.toContain('example-org');
  });
});

describe('jobs.groovy：Job 拓撲、信任策略與保留（Req 1.1、2.7、21.3–21.5）', () => {
  const code = codeOnly(jobsText);

  test('Job 與資料夾名稱', () => {
    const items = [...code.matchAll(/^(folder|multibranchPipelineJob|pipelineJob)\('([^']+)'\)/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(items).toEqual([
      'folder:ci', 'multibranchPipelineJob:ci/little-moments',
      'folder:release', 'multibranchPipelineJob:release/little-moments',
      'pipelineJob:release/rollback', 'pipelineJob:release/restore-drill', 'pipelineJob:release/digest-lookup',
      'folder:infra', 'pipelineJob:infra/build-image',
    ]);
  });

  test('Pipeline Job 由 main 分支的固定腳本載入，且腳本存在', () => {
    expect(groovyConst(jobsText, 'MAIN_BRANCH')).toBe('main');
    const paths = [...code.matchAll(/mainScript\('([^']+)'\)/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual([
      'ci/jenkins/pipelines/build-image.Jenkinsfile',
      'ci/jenkins/pipelines/digest-lookup.Jenkinsfile',
      'ci/jenkins/pipelines/restore-drill.Jenkinsfile',
      'ci/jenkins/pipelines/rollback.Jenkinsfile',
    ]);
    for (const p of paths.filter((x) => !x.endsWith('build-image.Jenkinsfile'))) expect(existsSync(resolve(root, p))).toBe(true);
    for (const name of ['ci/little-moments', 'release/little-moments']) {
      expect(block(code, 'multibranchPipelineJob', name)).toContain("workflowBranchProjectFactory { scriptPath('Jenkinsfile') }");
    }
  });

  test('ci/little-moments：PR 與非 main 分支、fork PR 信任「Admin or Write」（TrustPermission）', () => {
    const ci = block(code, 'multibranchPipelineJob', 'ci/little-moments');
    expect(ci).toContain('gitHubBranchDiscovery { strategyId(1) }');
    expect(ci).toContain('gitHubPullRequestDiscovery { strategyId(3) }');
    expect(ci).toMatch(/gitHubForkDiscovery \{\s*strategyId\(3\)\s*trust \{ gitHubTrustPermissions\(\) \}/);
    expect(ci).not.toMatch(/gitHubTrust(Everyone|Contributors)/);
    expect(ci).not.toContain('gitHubTagDiscovery');
    // main 不在 ci/ 自動建置：一般分支 AND NOT（名稱為 main）。
    expect(ci).toMatch(/buildAllBranches \{\s*strategies \{\s*buildRegularBranches\(\)\s*buildNoneBranches \{\s*strategies \{\s*buildNamedBranches \{\s*filters \{\s*exact \{\s*name\(MAIN_BRANCH\)\s*caseSensitive\(true\)/);
    expect(ci).toMatch(/buildChangeRequests \{\s*ignoreTargetOnlyChanges\(false\)\s*ignoreUntrustedChanges\(false\)/);
  });

  test('release/little-moments：只有 main 與 Tag（Tag build strategy），不探索 PR', () => {
    const rel = block(code, 'multibranchPipelineJob', 'release/little-moments');
    expect(rel).toContain('gitHubTagDiscovery()');
    expect(rel).toContain('headRegexFilter { regex(RELEASE_HEAD_REGEX) }');
    expect(rel).not.toMatch(/PullRequestDiscovery|ForkDiscovery|buildChangeRequests|buildRegularBranches/);
    expect(rel).toMatch(/buildTags \{\s*atLeastDays\(''\)\s*atMostDays\('7'\)/);
    expect(rel).toMatch(/buildNamedBranches \{\s*filters \{\s*exact \{\s*name\(MAIN_BRANCH\)\s*caseSensitive\(true\)/);
  });

  test('RELEASE_HEAD_REGEX 只接受 main 與 v<major>.<minor>.<patch>', () => {
    const re = new RegExp(groovyConst(jobsText, 'RELEASE_HEAD_REGEX').replace(/\\\\/g, '\\'));
    for (const ok of ['main', 'v0.0.0', 'v1.2.3', 'v999999.10.0']) expect(re.test(ok)).toBe(true);
    for (const bad of ['Main', 'main2', 'v01.2.3', 'v1.2.3-rc.1', 'release-1.2.3', 'v1000000.0.0', 'v1.2', 'feature/x', 'PR-1']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  test('保留：PR 14 天、main 90 天、Tag 365 天；回滾與還原演練 365 天', () => {
    expect(groovyConst(jobsText, 'KEEP_PR_DAYS')).toBe('14');
    expect(groovyConst(jobsText, 'KEEP_MAIN_DAYS')).toBe('90');
    expect(groovyConst(jobsText, 'KEEP_TAG_DAYS')).toBe('365');
    expect(groovyConst(jobsText, 'KEEP_RELEASE_JOB_DAYS')).toBe('365');
    expect(code).toMatch(/Closure prRetention = retention\(KEEP_PR_DAYS\)/);
    expect(code).toMatch(/Closure mainRetention = retention\(KEEP_MAIN_DAYS\)/);
    expect(code).toMatch(/Closure tagRetention = retention\(KEEP_TAG_DAYS\)/);
    const ci = block(code, 'multibranchPipelineJob', 'ci/little-moments');
    expect(ci).toMatch(/allBranchesSame \{\s*props\(prRetention\)/);
    expect(ci).toMatch(/discardOldItems \{\s*daysToKeep\(KEEP_PR_DAYS\.toInteger\(\)\)/);
    const rel = block(code, 'multibranchPipelineJob', 'release/little-moments');
    expect(rel).toMatch(/defaultProperties\(tagRetention\)\s*namedExceptions \{\s*named \{\s*name\(MAIN_BRANCH\)\s*props\(mainRetention\)/);
    expect(rel).toMatch(/discardOldItems \{\s*daysToKeep\(KEEP_RELEASE_JOB_DAYS\)/);
    for (const name of ['release/rollback', 'release/restore-drill']) {
      expect(block(code, 'pipelineJob', name)).toMatch(/logRotator \{\s*daysToKeep\(KEEP_RELEASE_JOB_DAYS\)/);
    }
    // 與 Jenkinsfile 自己的 buildDiscarder 一致（執行時以 Jenkinsfile 為準）。
    const days = (f) => /daysToKeepStr: '(\d+)'/.exec(JENKINSFILES[`ci/jenkins/pipelines/${f}`] ?? '')?.[1];
    expect(days('rollback.Jenkinsfile')).toBe('365');
    expect(days('restore-drill.Jenkinsfile')).toBe('365');
    expect(days('digest-lookup.Jenkinsfile')).toBe(groovyConst(jobsText, 'KEEP_LOOKUP_DAYS'));
    if (JENKINSFILES['ci/jenkins/pipelines/build-image.Jenkinsfile']) {
      expect(days('build-image.Jenkinsfile')).toBe(groovyConst(jobsText, 'KEEP_INFRA_DAYS'));
    }
  });

  test('restore-drill：cron H 3 1,15 * *（與 Jenkinsfile 相同）', () => {
    expect(block(code, 'pipelineJob', 'release/restore-drill')).toContain("cron { spec('H 3 1,15 * *') }");
    expect(JENKINSFILES['ci/jenkins/pipelines/restore-drill.Jenkinsfile']).toContain("cron('H 3 1,15 * *')");
  });

  test('digest-lookup 的參數與 Jenkinsfile 相同', () => {
    expect(block(code, 'pipelineJob', 'release/digest-lookup')).toContain("stringParam('DIGEST', '',");
    expect(JENKINSFILES['ci/jenkins/pipelines/digest-lookup.Jenkinsfile']).toContain("string(name: 'DIGEST'");
  });
});

describe('jobs.groovy：資料夾與 Job 層級授權（Req 21.12、19.3）', () => {
  const grants = permissionGrants(jobsText);

  test('只增加 Job/Build、Job/Cancel；唯一例外是 lm-retention-bot 在 release/little-moments 的 Run/Update', () => {
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.item).toBeDefined();
      for (const p of g.permissions) {
        expect(p.startsWith('Credentials/')).toBe(false);
        expect(p).not.toBe('Overall/Administer');
        if (!FORBIDDEN.includes(p)) continue;
        expect({ kind: g.kind, name: g.name, item: g.item, p }).toEqual({ kind: 'user', name: RETENTION_USER, item: 'release/little-moments', p: 'Run/Update' });
      }
    }
    const retention = grants.filter((g) => g.name === RETENTION_USER);
    expect(retention).toEqual([{ kind: 'user', name: RETENTION_USER, item: 'release/little-moments', permissions: ['Job/Read', 'Run/Update'] }]);
  });

  test('非管理員沒有 release/little-moments 與 infra/ 的 Job/Build；Release_Approver 可觸發回滾', () => {
    for (const g of grants.filter((x) => x.item === 'release/little-moments' || x.item.startsWith('infra'))) {
      expect(g.permissions).not.toContain('Job/Build');
    }
    expect(grants.find((g) => g.item === 'release/rollback' && g.name === 'lm-release-approvers')?.permissions).toContain('Job/Build');
    expect(grants.find((g) => g.item === 'release/digest-lookup' && g.name === 'lm-auditors')?.permissions).toEqual(['Job/Build']);
  });

  test('Release_Approver 清單的權威來源 ci/release-approvers.json 存在且 README 說明兩者需同步', () => {
    const doc = JSON.parse(read('ci/release-approvers.json'));
    expect(Array.isArray(doc.approvers)).toBe(true);
    expect(readme).toContain('ci/release-approvers.json');
    expect(readme).toContain('lm-release-approvers');
  });

  test('ci/release-approvers.json 的每個 jenkinsId 都是本機使用者資料庫的帳號（Req 19.3）', () => {
    const doc = JSON.parse(read('ci/release-approvers.json'));
    const users = localSec.jenkins.securityRealm.local.users.map((u) => u.id);
    expect(doc.approvers.length).toBeGreaterThan(0);
    for (const a of doc.approvers) expect(users).toContain(a.jenkinsId);
  });
});

describe('沒有秘密字面值（Req 15.1）', () => {
  const files = {
    'ci/jenkins/casc.yaml': cascText,
    'ci/jenkins/local-security.yaml': localSecText,
    'ci/jenkins/jobs.groovy': jobsText,
    'ci/jenkins/README.md': readme,
  };

  for (const [name, text] of Object.entries(files)) {
    test(name, () => {
      expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text).not.toMatch(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/);
      expect(text).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
      expect(text).not.toMatch(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/);
      // 長的十六進位或 Base64 字串（全 0 的範例簽章除外）。
      for (const m of text.matchAll(/[0-9a-f]{32,}/gi)) expect(/^0+$/.test(m[0])).toBe(true);
      for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) expect(m[0]).toMatch(/^([a-z/]+|0+)$/);
    });
  }

  for (const [name, text] of [['casc.yaml', cascText], ['local-security.yaml', localSecText]]) {
    test(`${name} 的 secret／password 欄位只引用 \${VAR}`, () => {
      const fields = [...text.matchAll(/^\s*(secret|password|privateKey|passphrase|token|apiToken):\s*(.*)$/gm)];
      expect(fields.length).toBeGreaterThan(0);
      for (const m of fields) expect(m[2]).toMatch(/^"\$\{[A-Z][A-Z0-9_]*\}"$/);
    });
  }

  test('README 列出每個資料夾憑證 ID、必要 plugins 與驗證步驟', () => {
    for (const folder of Object.keys(FOLDERS)) {
      for (const id of idsOf(folder)) expect(readme).toContain(`\`${id}\``);
    }
    for (const plugin of ['configuration-as-code', 'job-dsl', 'github-branch-source', 'basic-branch-build-strategies', 'matrix-auth', 'lockable-resources', 'job-restrictions', 'credentials-binding']) {
      expect(readme).toContain(`\`${plugin}\``);
    }
    expect(readme).toContain('### Untrusted Agent 網路隔離（Req 2.6）');
    expect(readme).toContain('### Webhook 驗證與拒絕日誌（Req 2.1、2.2）');
    expect(readme).toContain('### 解除 keepLog（管理員程序）');
  });
});
