// ci/jenkins/pipelines/rollback.Jenkinsfile 的靜態檢查（Req 20.8–20.12）。
// 本機沒有 Jenkins／Groovy，這裡只檢查結構、關鍵字與步驟順序，不能取代 Jenkins 的實際語法驗證或整合測試。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const source = readFileSync(resolve(root, 'ci/jenkins/pipelines/rollback.Jenkinsfile'), 'utf8');

/** 移除註解與字串內容（保留引號本身），只留下 Groovy 結構供括號與關鍵字檢查。 */
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('//')) { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (rest.startsWith('/*')) { const n = text.indexOf('*/', i + 2); if (n < 0) throw new Error('未結束的區塊註解'); i = n + 2; continue; }
    const quote = rest.startsWith("'''") ? "'''" : rest.startsWith('"""') ? '"""' : (rest[0] === "'" || rest[0] === '"') ? rest[0] : null;
    if (quote) {
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++;
        if (quote.length === 1 && text[j] === '\n') throw new Error(`第 ${text.slice(0, i).split('\n').length} 行字串未結束`);
        j++;
      }
      if (j >= text.length) throw new Error('未結束的字串');
      out += quote + quote;
      i = j + quote.length;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** 取出所有單引號字串（含 ''' 區塊）的內容。 */
function singleQuoted(text) {
  const out = [];
  const noComments = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const m of noComments.matchAll(/'''([\s\S]*?)'''|'((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** 取出 Groovy 方法本體（以名稱定位，依大括號配對）。 */
function methodBody(name) {
  const start = source.search(new RegExp(`^\\S.*\\b${name}\\([^)]*\\)\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`找不到方法 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  // 在原始碼上逐字掃描（略過字串與註解）找出配對的右大括號。
  let k = open;
  let inStr = null;
  for (; k < source.length; k++) {
    const c = source[k];
    if (inStr) {
      if (source.startsWith(inStr, k)) { k += inStr.length - 1; inStr = null; } else if (c === '\\') k++;
      continue;
    }
    if (source.startsWith("'''", k)) { inStr = "'''"; k += 2; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (source.startsWith('//', k)) { k = source.indexOf('\n', k); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(open, k + 1);
}

const structure = stripCommentsAndStrings(source);
const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('rollback.Jenkinsfile 結構', () => {
  test('括號在註解與字串之外成對且順序正確', () => {
    const pairs = { ')': '(', '}': '{', ']': '[' };
    const stack = [];
    for (const ch of structure) {
      if ('({['.includes(ch)) stack.push(ch);
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch]);
    }
    expect(stack).toEqual([]);
  });

  test('單一 Declarative pipeline，Trusted Agent、365 天保留與必要 options', () => {
    expect(structure.match(/^pipeline\s*\{/gm)?.length).toBe(1);
    expect(code).toContain("agent { label 'lm-trusted' }");
    for (const opt of ['skipDefaultCheckout()', 'timestamps()', 'disableResume()', "logRotator(daysToKeepStr: '365')"]) {
      expect(code).toContain(opt);
    }
  });

  test('階段依序為 Init → Status → Select → Rollback，post always 寫入 Build_Record', () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names).toEqual(['Init', 'Status', 'Select', 'Rollback']);
    const post = code.slice(code.indexOf('post {'));
    expect(post).toMatch(/always\s*\{[\s\S]*writeRollbackRecord\(\)[\s\S]*archiveArtifacts/);
  });
});

describe('輸入處理與 shell 安全', () => {
  test('沒有 Groovy 字串插值（不使用雙引號字串）', () => {
    // 去除單引號字串後，不得剩下任何雙引號字串（GString）。
    const withoutSingle = code.replace(/'''[\s\S]*?'''/g, "''").replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    expect(withoutSingle).not.toContain('"');
  });

  test('每個 sh 的 script 都是單引號字串或固定的 sshPrelude() + 子命令', () => {
    const scripts = [...code.matchAll(/script:\s*([^\n]+)/g)].map((m) => m[1].trim());
    expect(scripts.length).toBeGreaterThan(5);
    for (const s of scripts) expect(s.startsWith("'") || s === 'sshPrelude() + command)').toBe(true);
  });

  test('回滾理由只經環境變數傳遞，不出現在任何 shell 字串或建置描述中', () => {
    const shellStrings = singleQuoted(source).filter((s) => /bun |lm_ssh|ssh /.test(s));
    for (const s of shellStrings) expect(s).not.toMatch(/LM_ROLLBACK_REASON|reason/i);
    const assigns = [...code.matchAll(/LM_ROLLBACK_REASON/g)].length;
    expect(assigns).toBe(2); // Init 初始化 + input 結果
    expect(code).toMatch(/env\.LM_ROLLBACK_REASON = \(r instanceof Map && r\.reason != null\)/);
    expect(methodBody('setSummary')).not.toMatch(/reason/i);
  });

  test('shell 只以加雙引號的環境變數取用 digest、帳號與槽位', () => {
    const shell = singleQuoted(source).join('\n');
    for (const v of ['LM_ROLLBACK_DIGEST', 'LM_RB_TRIGGERED_BY', 'LM_RB_APPROVER', 'LM_RB_COLOR']) {
      const uses = [...shell.matchAll(new RegExp(`\\$\\{?${v}`, 'g'))];
      expect(uses.length).toBeGreaterThan(0);
      for (const m of shell.matchAll(new RegExp(`.\\$\\{?${v}`, 'g'))) expect(m[0][0]).toBe('"');
    }
  });
});

describe('Release_Approver 與保留集合檢查（Req 20.10）', () => {
  test('觸發者以 ci/approval.mjs release 檢查，失敗即拒絕且未接觸 Deploy_Host', () => {
    const init = code.slice(code.indexOf("stage('Init')"), code.indexOf("stage('Status')"));
    expect(init).toContain('bun ci/approval.mjs release --approver "$LM_RB_TRIGGERED_BY"');
    expect(init).toContain('觸發者不是 Release_Approver');
    expect(init).not.toContain('deployHost(');
    expect(code).toContain("getBuildCauses('hudson.model.Cause$UserIdCause')");
    expect(code).toContain('ReplayCause');
  });

  test('digest 選項來自 lm-deploy status 的可回滾目標，以 input choice 呈現並限定 submitter', () => {
    const select = code.slice(code.indexOf("stage('Select')"), code.indexOf("stage('Rollback')"));
    expect(select).toMatch(/timeout\(time: 30, unit: 'MINUTES'\)/);
    expect(select).toContain('submitter: env.LM_RB_SUBMITTERS');
    expect(select).toContain("submitterParameter: 'approver'");
    expect(select).toMatch(/choice\(\s*name: 'digest',\s*choices: env\.LM_RB_CHOICES/);
    expect(select).toMatch(/string\(\s*name: 'reason'/);
    expect(select).toContain("checkRollback('status-before.json')");
    const status = code.slice(code.indexOf("stage('Status')"), code.indexOf("stage('Select')"));
    expect(status).toContain("fetchTargets('status-before.json')");
    expect(methodBody('fetchTargets')).toContain('bun ci/rollback.mjs targets');
  });

  test('checkRollback 以 ci/rollback.mjs check（isReleaseApprover + rollbackAllowed）判定', () => {
    const body = methodBody('checkRollback');
    expect(body).toContain('bun ci/rollback.mjs check --status "$LM_RB_STATUS" --digest "$LM_ROLLBACK_DIGEST"');
    expect(body).toContain('--triggered-by "$LM_RB_TRIGGERED_BY" --approver "$LM_RB_APPROVER"');
    expect(body).toMatch(/if \(rc != 0 \|\| d\.allowed != true\)/);
    expect(body).toContain('Production 目前版本與 reverse proxy 設定未變更');
  });
});

describe('並行控制與切換流程（Req 20.8、20.9、20.11、20.12）', () => {
  test('lock(lm-prod, skipIfLocked) 後以旗標判斷，跳過時以「已有部署進行中」失敗', () => {
    const stage = code.slice(code.indexOf("stage('Rollback')"), code.indexOf('post {'));
    expect(stage).toMatch(/boolean acquired = false\s*lock\(resource: 'lm-prod', skipIfLocked: true\) \{\s*acquired = true\s*performRollback\(\)\s*\}/);
    expect(stage).toMatch(/if \(!acquired\) \{[\s\S]*'locked'[\s\S]*已有部署進行中/);
  });

  test('performRollback：重新檢查 → rollback → 切換後 health --wait → finalize，順序固定', () => {
    const body = methodBody('performRollback');
    const steps = [
      "deployHost('status', 'status-locked.json')",
      "checkRollback('status-locked.json')",
      "deployHost('rollback', 'rollback.jsonl')",
      "classify('classify', rc, 'rollback.jsonl')",
      "deployHost('health', 'health-after.jsonl')",
      "classify('health', hrc, 'health-after.jsonl')",
      "deployHost('finalize', 'finalize.jsonl')",
      "env.LM_RB_OUTCOME = 'completed'",
    ];
    const idx = steps.map((s) => body.indexOf(s));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('切換後未健康：標記需人工介入並停止，之後沒有任何自動切換', () => {
    const body = methodBody('performRollback');
    const unhealthy = body.slice(body.indexOf('if (h.healthy != true)'));
    const block = unhealthy.slice(0, unhealthy.indexOf('}') + 1);
    expect(block).toContain("env.LM_RB_OUTCOME = 'manual_intervention'");
    expect(block).toContain("env.LM_RB_MANUAL = 'true'");
    expect(block).toContain('需人工介入');
    expect(block).toContain('error(');
    expect(block).not.toContain('deployHost(');
  });

  test('只呼叫 status／rollback／health／finalize，不執行遷移、備份或部署', () => {
    const body = methodBody('deployHost');
    const cmds = [...body.matchAll(/'lm_ssh ([a-z-]+)/g)].map((m) => m[1]);
    expect(cmds.sort()).toEqual(['finalize', 'health', 'rollback', 'status']);
    expect(body).toContain('\'lm_ssh rollback "$LM_ROLLBACK_DIGEST" > "$LM_RB_OUT"\\n\'');
    expect(body).toContain('\'lm_ssh health "$LM_RB_COLOR" --wait > "$LM_RB_OUT"\\n\'');
    for (const forbidden of [/lm_ssh (migrate|backup|deploy|start|switch|app-env|prune)\b/, /\bmigrate\b/]) {
      expect(singleQuoted(source).join('\n')).not.toMatch(forbidden);
    }
    const calls = [...code.matchAll(/deployHost\('([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(calls)).toEqual(new Set(['status', 'rollback', 'health', 'finalize']));
  });
});

describe('SSH 與憑證', () => {
  test('憑證只以 withCredentials 綁定（sshUserPrivateKey + known_hosts secret file + registry pull）', () => {
    expect(code).not.toMatch(/credentials\(/);
    const ids = [...code.matchAll(/credentialsId:/g)].length;
    expect(ids).toBe(3);
    expect(code).toContain("sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')");
    expect(code).toContain("file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')");
    const body = methodBody('deployHost');
    expect(body.indexOf('withCredentials(')).toBeLessThan(body.indexOf('sh('));
  });

  test('嚴格主機金鑰檢查，不信任首次連線、不讀取 ssh_config 或 agent', () => {
    const prelude = methodBody('sshPrelude');
    for (const opt of ['-F /dev/null', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile="$LM_KNOWN_HOSTS"', 'GlobalKnownHostsFile=/dev/null',
      'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'UpdateHostKeys=no', '-i "$LM_SSH_KEY"']) {
      expect(prelude).toContain(opt);
    }
    expect(source).not.toMatch(/StrictHostKeyChecking=(no|accept-new)|ssh-keyscan|known_hosts\s*>>/);
  });

  test('Build_Image 只以 digest 引用；PLACEHOLDER 未取代時格式檢查失敗（fail closed）', () => {
    const image = /BUILD_IMAGE = '([^']+)'/.exec(code)?.[1];
    expect(image).toMatch(/@sha256:<digest>$/);
    const groovyRe = /ref ==~ \/(.+)\/\)\)/.exec(methodBody('buildImageDigest'))?.[1];
    expect(groovyRe).toBeTruthy();
    const re = new RegExp(groovyRe.replace(/\\\//g, '/'));
    expect(re.test(image)).toBe(false);
    expect(re.test(`registry.lan.example:8443/little-moments/build-image@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(re.test('registry.lan.example:8443/little-moments/build-image:latest')).toBe(false);
  });
});

describe('Build_Record（Req 20.9、20.11）', () => {
  test('post 以 ci/rollback.mjs record 記錄觸發者、來源與目標 digest、結果與需人工介入', () => {
    const body = methodBody('writeRollbackRecord');
    for (const arg of ['--by "$LM_RB_TRIGGERED_BY"', '--from "$LM_RB_FROM"', '--to "$LM_ROLLBACK_DIGEST"', '--outcome "$LM_RB_OUTCOME"',
      '--manual-intervention "$LM_RB_MANUAL"', '--attempted "$LM_RB_ATTEMPTED"', '--status "$LM_RB_RESULT_STATUS"']) {
      expect(body).toContain(arg);
    }
    expect(body).toMatch(/catch \(err\) \{[\s\S]*currentBuild\.result = 'FAILURE'/);
  });
});
