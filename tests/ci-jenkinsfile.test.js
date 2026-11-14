// Jenkinsfile 骨架的靜態檢查（Req 1.1、1.6、3.1、3.3、3.4、3.6、22.1、23.4）。
// 本機沒有 Jenkins／Groovy，這裡只檢查結構與關鍵字，不能取代 Jenkins 的實際語法驗證。
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { STAGE } from '../ci/stages.mjs';
import { recordPatch, toolchainRecord } from '../ci/verify-toolchain.mjs';
import { createRecord, mergeRecord, validateRecord } from '../ci/record.mjs';

const root = resolve(import.meta.dir, '..');
const source = readFileSync(resolve(root, 'Jenkinsfile'), 'utf8');

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

const structure = stripCommentsAndStrings(source);
const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('Jenkinsfile 結構', () => {
  test('括號在註解與字串之外成對且順序正確', () => {
    const pairs = { ')': '(', '}': '{', ']': '[' };
    const stack = [];
    for (const ch of structure) {
      if ('({['.includes(ch)) stack.push(ch);
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch]);
    }
    expect(stack).toEqual([]);
  });

  test('Declarative pipeline 只有一個 pipeline 區塊，且 options 含必要選項', () => {
    expect(structure.match(/^pipeline\s*\{/gm)?.length).toBe(1);
    const options = /options\s*\{([^}]*)\}/.exec(structure)?.[1] ?? '';
    for (const opt of ['skipDefaultCheckout()', 'timestamps()', 'disableResume()']) expect(options).toContain(opt);
  });

  test('不提供任何建置參數；唯一的 input 是 Release_Tag 的核准迴圈，且沒有可略過關卡的參數或選項（Req 23.4、19.3、12.6）', () => {
    expect(structure).not.toMatch(/\bparameters\s*[{(]/);
    expect(structure).not.toMatch(/\bparams\./);
    // 13.7 起 Release_Tag 的正式核准（Req 19）使用 Pipeline: Input Step。input 只允許出現在兩個核准迴圈內：
    // 只有 submitterParameter（沒有 parameters，也就沒有任何可略過或放寬 Release_Gate 的選項），submitter 限定
    // Release_Approver，送出者另以 ci/approval.mjs 再驗證（Jenkins 管理員可送出任何 input），不生效時繼續等待。
    const loops = [functionBody('Map releaseApprovalLoop(String message)'), functionBody('Map destructiveApprovalLoop(Map m)')];
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    const inputs = [...code.matchAll(/\binput\s*\(/g)].map((m) => m.index);
    expect(inputs.length).toBe(2);
    for (const i of inputs) expect(loops.some((b) => inside(i, b))).toBe(true);
    for (const b of loops) {
      const call = /\binput\(([^\n]*)\)\n/.exec(b)?.[1] ?? '';
      expect(call).toContain('submitter: env.LM_APR_SUBMITTERS');
      expect(call).toContain("submitterParameter: 'approver'");
      expect(call).not.toMatch(/\bparameters\s*:/);
      expect(b).toContain('while (true)');
      expect(b).toContain('recordAttempt(who, ');
      expect(b).toContain('String who = inputRejecter(err)');
    }
    expect(loops[0]).toContain('if (isApprover(who))');
    expect(loops[1]).toContain('if (destructiveAllowed(who, migration))');
    expect(functionBody('boolean isApprover(String who)')).toContain('bun ci/approval.mjs release --approver "$LM_APR_WHO"');
    expect(functionBody('boolean destructiveAllowed(String who, String migration)'))
      .toContain('bun ci/approval.mjs destructive --approver "$LM_APR_WHO" --migration "$LM_APR_MIGRATION"');
    // 核准迴圈只由 Release_Tag 的 Approval 階段呼叫，且整體 24 小時逾時（Req 19.4）。
    const approval = stageCode(STAGE.APPROVAL);
    expect(approval).toContain("env.LM_TRIGGER_KIND == 'release_tag'");
    expect(approval).toContain('waitForApproval()');
    const wait = functionBody('void waitForApproval()');
    expect(wait).toContain("timeout(time: 24, unit: 'HOURS')");
    expect(wait).toContain('releaseApprovalLoop(message)');
    expect(wait).toContain('destructiveApprovalLoop(m)');
    expect([...code.matchAll(/releaseApprovalLoop\(|destructiveApprovalLoop\(/g)].length).toBe(4);
  });

  test('Build_Image 以 @sha256: digest 引用（Req 3.1）', () => {
    const ref = /BUILD_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(ref).toBeDefined();
    expect(ref).toMatch(/@sha256:/);
    expect(ref).not.toMatch(/:latest\b/);
    expect(code).toContain('docker.image(env.BUILD_IMAGE)');
  });

  test('checkout scm 後以 git rev-parse HEAD 固定 Commit SHA（Req 1.6）', () => {
    const checkout = code.indexOf('checkout scm');
    const revParse = code.indexOf("'git rev-parse HEAD'");
    expect(checkout).toBeGreaterThan(-1);
    expect(revParse).toBeGreaterThan(checkout);
    expect(code.match(/checkout scm/g)?.length).toBe(1);
  });

  test('階段名稱屬於 ci/stages.mjs 且依序為 Init → Tag Verify → Toolchain → Install → Build → Unit Tests → Browser Tests → Security Scan', () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    const known = new Set(Object.values(STAGE));
    for (const n of names) expect(known.has(n)).toBe(true);
    expect(names.slice(0, 8)).toEqual([
      STAGE.INIT, STAGE.TAG_VERIFY, STAGE.TOOLCHAIN, STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.BROWSER, STAGE.SECURITY,
    ]);
    // enterStage 名稱與 stage 名稱一致。
    expect([...code.matchAll(/enterStage\('([^']+)'\)/g)].map((m) => m[1])).toEqual(names);
  });

  test('pending 通知、Build_Record、工具鏈驗證都在安裝之前；建置在安裝之後（Req 3.3、3.6、21.1、22.1）', () => {
    const at = (s) => { const i = code.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
    const install = at('bun install --frozen-lockfile\n');
    expect(at("notifyAll('pending'")).toBeLessThan(install);
    expect(at('bun ci/record.mjs init')).toBeLessThan(install);
    expect(at('bun ci/policy/tag.mjs')).toBeLessThan(install);
    expect(at('bun ci/verify-toolchain.mjs')).toBeLessThan(install);
    expect(at("'bun run build'")).toBeGreaterThan(install);
  });

  test('只使用 --frozen-lockfile 安裝，不執行會修改 bun.lock 的指令（Req 3.4）', () => {
    for (const m of code.matchAll(/bun install[^\n]*/g)) expect(m[0]).toContain('--frozen-lockfile');
    expect(code).not.toMatch(/\bbun (add|update|remove|pm)\b/);
    expect(code).not.toMatch(/\b(npm|yarn|pnpm) /);
  });

  test('憑證只以 withCredentials 綁定，不使用 environment 的 credentials()（Req 15.1）', () => {
    expect(code).not.toMatch(/credentials\(/);
    const ids = [...code.matchAll(/credentialsId:/g)].length;
    const bound = [...code.matchAll(/withCredentials\(\[/g)].length;
    expect(ids).toBeGreaterThan(0);
    expect(bound).toBe(ids);
  });
});

/** 取出 stage('name') 區塊的原始碼（到下一個 stage 或輔助函式區段為止）。 */
function stageBlock(name) {
  const start = code.indexOf(`stage('${name}')`);
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.search(/stage\('|\n\/\/ -{10,}|\nvoid |\nint |\nString |\nboolean |\nMap |\nList |\ndef /);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/** 取出 Groovy 函式本體（以括號配對）。 */
function functionBody(signature) {
  const start = code.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const open = code.indexOf('{', start + signature.length);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error(`找不到 ${signature} 的結尾`);
}

/**
 * stage 的完整內容：stage 宣告（stageBlock：when、steps、post）加上它呼叫的階段函式與 post 函式本體。
 * Components 第 22 節起，各 stage 的 steps 與多於一個敘述的 post 內容位於 pipeline {} 之後的頂層函式
 * （run<階段名稱>Stage()、<階段>Post<條件>()）；順序為 stage 宣告 → run…Stage() → post 函式。
 */
function stageCode(name) {
  const block = stageBlock(name);
  const fns = [...block.matchAll(/script \{ (run\w+Stage|[a-z]\w*Post(?:Always|Unsuccessful|Cleanup))\(\) \}/g)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith('pipelinePost'));
  expect(fns[0]).toMatch(/^run\w+Stage$/);
  return [block, ...fns.map((f) => functionBody(`void ${f}()`))].join('\n');
}

/** 所有 ''' 多行 sh 腳本（含以位置參數傳給 runScan 的腳本）。 */
const tripleScripts = [...source.matchAll(/(?:script: |, )'''([\s\S]*?)'''/g)].map((m) => m[1]);

/** Groovy 單引號字串的跳脫：`\` + 換行為續行，其餘 `\x` 依 Groovy 規則轉換（與 ci-jenkinsfile-shell-env.test.js 相同）。 */
function groovyUnescape(raw) {
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  return raw.replace(/\\(\n|.)/g, (_, c) => (c === '\n' ? '' : (map[c] ?? c)));
}

/** 有 git 的 POSIX sh：Linux 優先 dash；Windows 經 WSL（同樣優先 dash）。回傳 { prefix, sh, toPath, label } 或 null。 */
function findPosixShell() {
  const ok = (cmd, args) => spawnSync(cmd, args, { timeout: 60_000, encoding: 'utf8' }).status === 0;
  const probe = 'command -v git >/dev/null 2>&1';
  if (process.platform === 'win32') {
    for (const sh of ['dash', 'sh']) {
      if (!ok('wsl.exe', ['-e', sh, '-c', probe])) continue;
      const toPath = (p) => {
        const r = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', p.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60_000 });
        if (r.status !== 0) throw new Error(`wslpath 失敗：${r.stderr}`);
        return r.stdout.trim();
      };
      return { prefix: ['wsl.exe', '-e'], sh, toPath, label: `WSL ${sh}` };
    }
    return null;
  }
  for (const sh of ['dash', 'sh']) if (ok(sh, ['-c', probe])) return { prefix: [], sh, toPath: (p) => p, label: sh };
  return null;
}

/**
 * 「Gitleaks history range」腳本的測試驅動（POSIX sh）：參數為 <sh> <腳本> 之後每三個一組
 * （LM_SCAN_BASE_REF、LM_GITLEAKS_HISTORY_BASE、GIT_PREVIOUS_SUCCESSFUL_COMMIT）。在臨時 repository 建立
 * A–B–C–D（refs/heads/main）與自 A 分岔的 X（refs/heads/side），以 env -i 只傳入指定變數執行腳本（-e，cwd 為 repository），
 * 每組輸出一行 `out=<stdout>`。符號：A–D、X 為 SHA；EMPTY 為空字串（LM_SCAN_BASE_REF 為 EMPTY 時不設定）；
 * UNSET 為不設定；SHORT 不是 40 hex；UPPER 為 B 的大寫；MISSING 為不存在的 40 hex。
 */
const RANGE_DRIVER = `set -eu
sh_bin="$1"; script="$2"; shift 2
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
git init -q "$t/repo"
cd "$t/repo"
tree="$(git mktree </dev/null)"
A="$(git commit-tree -m A "$tree")"
B="$(git commit-tree -p "$A" -m B "$tree")"
C="$(git commit-tree -p "$B" -m C "$tree")"
D="$(git commit-tree -p "$C" -m D "$tree")"
X="$(git commit-tree -p "$A" -m X "$tree")"
git update-ref refs/heads/main "$D"
git update-ref refs/heads/side "$X"
printf 'A=%s\\nB=%s\\nC=%s\\nD=%s\\nX=%s\\n' "$A" "$B" "$C" "$D" "$X"
val() {
  case "$1" in
    A) printf '%s' "$A" ;; B) printf '%s' "$B" ;; C) printf '%s' "$C" ;; D) printf '%s' "$D" ;; X) printf '%s' "$X" ;;
    EMPTY) ;;
    SHORT) printf '%s' abc123 ;;
    UPPER) printf '%s' "$B" | tr a-f A-F ;;
    MISSING) printf '%s' 0123456789abcdef0123456789abcdef01234567 ;;
    *) printf '%s' "$1" ;;
  esac
}
while [ $# -ge 3 ]; do
  ref="$1"; base="$2"; prev="$3"; shift 3
  vars="GIT_COMMIT_FULL=$D"
  [ "$ref" = EMPTY ] || vars="$vars LM_SCAN_BASE_REF=$ref"
  [ "$base" = UNSET ] || vars="$vars LM_GITLEAKS_HISTORY_BASE=$(val "$base")"
  [ "$prev" = UNSET ] || vars="$vars GIT_PREVIOUS_SUCCESSFUL_COMMIT=$(val "$prev")"
  out="$(env -i PATH="$PATH" HOME="$t" $vars "$sh_bin" -e "$script")" || { echo "script failed: $ref $base $prev" >&2; exit 1; }
  printf 'out=%s\\n' "$out"
done
`;

/** 文字中所有 docker run／create 指令（含以 `\` 續行的參數）。 */
function dockerRunsIn(text) {
  return [...text.matchAll(/docker (?:run|create)\b((?:[^\n]*\\\n)*[^\n]*)/g)].map((m) => m[1]);
}

describe('Unit Tests 與 Browser Tests 階段（Req 4、5、23.1、23.5）', () => {
  const unit = stageCode('Unit Tests');
  const browser = stageCode('Browser Tests');
  const startDb = functionBody('void startEphemeralDb(String purpose)');
  const destroyDb = functionBody('void destroyEphemeralDb()');
  const recordQa = functionBody('int recordQa(Map args)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };

  test('所有 sh 腳本皆為單引號字串，不經 Groovy 插值（含新增階段）', () => {
    expect(code).not.toMatch(/script:\s*"/);
    expect(code).not.toMatch(/\bsh\s*\(?\s*"/);
    expect(code).not.toMatch(/script:\s*"""/);
  });

  test('Ephemeral_Database：digest 固定、internal 網路、tmpfs、不發布連接埠、建置標籤（Req 4.2、4.8）', () => {
    const ref = /LM_POSTGRES_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(ref).toMatch(/^postgres:[^@\s]+@sha256:/);
    // 與 deploy/compose/compose.yaml 的 db 使用同一個 repo:tag 與 digest。
    expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    const compose = readFileSync(resolve(root, 'deploy/compose/compose.yaml'), 'utf8');
    expect(compose).toContain(`image: ${ref}`);
    expect(startDb).toContain('docker network create --internal');
    expect(startDb).toContain('--tmpfs /var/lib/postgresql/data');
    expect(startDb).toContain('--label "lm.ci.build=$BUILD_TAG"');
    expect(startDb).toContain('--label "lm.ci.edb=$LM_EDB_RUN"');
    expect(startDb).toMatch(/grep -Eq '\^\[0-9a-f\]\{64\}\$'/);
    // 整份 Jenkinsfile 都不發布連接埠、不使用 host 網路、不建立卷。
    for (const cmd of dockerRunsIn(source)) {
      expect(cmd).not.toMatch(/\s(-p|--publish|--publish-all|-P)(\s|=)/);
      expect(cmd).not.toMatch(/\s(-v|--volume)(\s|=)/);
    }
    // Ephemeral_Database 容器不掛載任何主機路徑，只連接本階段網路。
    const edbRuns = dockerRunsIn(startDb);
    expect(edbRuns.length).toBeGreaterThan(0);
    for (const cmd of edbRuns) {
      expect(cmd).not.toMatch(/\s--mount(\s|=)/);
      expect(cmd).toContain('--network "$LM_EDB_NET"');
    }
    expect(code).not.toMatch(/--network[ =]host/);
    expect(code).not.toMatch(/docker volume create/);
    expect(code).not.toMatch(/--publish/);
    // 測試容器只連接本階段網路，名稱格式受限。
    // 13.4 起 Migration Compatibility 與 DAST 也各自建立 Ephemeral_Database（用途 compat／dast）。
    expect(code).toMatch(/inBuildImageOn\(String network, Closure body\)[\s\S]*?\^lm-edb-\(unit\|e2e\|compat\|dast\)-\[0-9a-f\]\{16\}-net\$/);
    expect(startDb).toContain("purpose ==~ /^(unit|e2e|compat|dast)$/");
    expect(code).toContain('buildImageContainer("--network ${network}", body)');
    expect(unit).toContain("startEphemeralDb('unit')");
    expect(browser).toContain("startEphemeralDb('e2e')");
    expect(unit).toContain('inBuildImageOn(env.LM_EDB_NET)');
    expect(browser).toContain('inBuildImageOn(env.LM_EDB_NET)');
  });

  test('120 秒內未就緒即失敗，且不執行測試（Req 4.6）', () => {
    expect(startDb).toContain('deadline=$(( $(date +%s) + 120 ))');
    expect(startDb).toContain('pg_isready');
    expect(startDb).toMatch(/rc == 3\)\s*\{\s*error\(/);
    expect(startDb).toMatch(/rc != 0\)\s*\{\s*error\(/);
    expect(at(unit, "startEphemeralDb('unit')")).toBeLessThan(at(unit, 'bun scripts/migrate.mjs'));
  });

  test('隨機密碼只存在 0600 檔，不進入 Groovy、命令列或主控台（Req 4.3、15.2）', () => {
    expect(startDb).toContain('umask 077');
    expect(startDb).toContain('mkdir -m 0700 "$LM_EDB_DIR"');
    expect(startDb).toContain('/dev/urandom');
    expect(startDb).toContain('--env-file "$LM_EDB_DIR/db.env"');
    expect(code).not.toMatch(/-e\s+"?POSTGRES_PASSWORD/);
    expect(functionBody('List testEnv()')).not.toContain('PASSWORD');
    expect(code).not.toMatch(/env\.\w*PASSWORD/);
    // 讀取或產生密碼的腳本第一行一律關閉 xtrace（Jenkins sh 預設 -x）。
    const secretScripts = tripleScripts.filter((s) => /client\.env|POSTGRES_PASSWORD|scrub-secrets/.test(s));
    expect(secretScripts.length).toBeGreaterThanOrEqual(4);
    for (const s of secretScripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
    for (const s of tripleScripts) expect(s).not.toMatch(/echo[^\n]*\$(pw|CAMPING_TEST_DATABASE_PASSWORD|CAMPING_DATABASE_PASSWORD)/);
  });

  test('測試只取得 Ephemeral_Database 的連線設定（Req 4.1、4.3）與 CHROME_PATH／CAMPING_BUN（Req 3.8）', () => {
    const envList = functionBody('List testEnv()');
    for (const name of ['CAMPING_TEST_DATABASE_HOST', 'CAMPING_TEST_DATABASE_PORT', 'CAMPING_TEST_DATABASE_NAME', 'CAMPING_TEST_DATABASE_USER', 'CHROME_PATH=/', 'CAMPING_BUN=/']) {
      expect(envList).toContain(name);
    }
    expect(envList).not.toMatch(/CAMPING_DATABASE_/);
    // 唯一使用 CAMPING_DATABASE_* 的地方是 Migration_Runner，且值全部來自 CAMPING_TEST_DATABASE_*。
    for (const m of code.matchAll(/CAMPING_DATABASE_(\w+)="([^"]*)"/g)) {
      expect(m[2]).toBe(`$CAMPING_TEST_DATABASE_${m[1]}`);
    }
    expect(code).not.toMatch(/withCredentials[\s\S]{0,200}(DATABASE|POSTGRES)/);
  });

  test('Unit Tests：Migration_Runner → verify-env → bun test（15 分鐘）→ JUnit 與測試數量檢查（Req 4.1、4.4、4.5、4.7）', () => {
    const migrate = at(unit, 'bun scripts/migrate.mjs');
    const verify = at(unit, 'verifyTestEnv()');
    const test_ = at(unit, 'bun test --reporter=junit --reporter-outfile=reports/unit-junit.xml tests/*.test.js');
    const gate = at(unit, 'bun ci/gates.mjs junit --gate QA');
    expect(migrate).toBeLessThan(verify);
    expect(verify).toBeLessThan(test_);
    expect(test_).toBeLessThan(gate);
    expect(unit).toContain('timeout --kill-after=30 900 bun test');
    expect(unit).toMatch(/migrateRc != 0\)\s*\{\s*error\(/);
    expect(unit).toMatch(/testRc != 0 \|\| junitRc != 0\)\s*\{\s*error\(/);
    expect(functionBody('void verifyTestEnv()')).toContain('bun ci/verify-env.mjs --out reports/verify-env.json');
    expect(unit).toContain("junit(testResults: 'reports/unit-junit.xml', allowEmptyResults: true)");
    expect(unit).toContain("unitJunit: 'reports/unit-junit.xml'");
  });

  test('Browser Tests：validate → check-accounts（60 分鐘，不傳 --reporter）→ compare →「QA」關卡（Req 5.3、5.4、5.8、5.9）', () => {
    const validate = at(browser, 'bun scripts/qa-inventory.mjs validate qa/inventory.json');
    const db = at(browser, "startEphemeralDb('e2e')");
    const e2e = at(browser, 'node scripts/check-accounts.mjs');
    const compare = at(browser, 'bun scripts/qa-inventory.mjs compare qa/inventory.json reports/e2e.json --out reports/qa-inventory.json');
    const gate = at(browser, 'gate: true');
    expect(validate).toBeLessThan(db);
    expect(db).toBeLessThan(e2e);
    expect(e2e).toBeLessThan(compare);
    expect(compare).toBeLessThan(gate);
    expect(browser).toMatch(/validateRc != 0\)\s*\{\s*error\(/);
    expect(browser).toContain('timeout --kill-after=60 3600 node scripts/check-accounts.mjs');
    expect(browser).toMatch(/e2eRc != 0\)\s*\{\s*error\(/);
    expect(browser).toMatch(/gateRc != 0\)\s*\{\s*error\(/);
    // CI 不覆寫 playwright.config.js 的 reporter（reports/e2e.json 與 JUnit 由設定檔產生），也不重試。
    expect(code).not.toMatch(/check-accounts\.mjs[^\n]*--(reporter|retries)/);
    expect(code).not.toMatch(/--retries/);
    expect(browser).toContain("inventory: 'reports/qa-inventory.json'");
    expect(code).toMatch(/List qaJunitReports\(\)\s*\{\s*return \['reports\/unit-junit\.xml', 'reports\/e2e-junit\.xml'\]/);
  });

  test('「QA」關卡以 ci/gates.mjs 評估並寫入 Build_Record；階段失敗時記錄為未通過（Req 23.1、23.3、23.5）', () => {
    expect(recordQa).toContain('bun ci/gates.mjs junit --gate QA --commit "$GIT_COMMIT_FULL" --out reports/gate-qa.json');
    // Jenkins 不傳空值的環境變數（JENKINS-43632），可能為空的變數以 ${X:-} 展開（Components 第 24.4 節）。
    expect(recordQa).toContain('--inventory "${LM_GATE_INVENTORY:-}"');
    expect(recordQa).toContain('--stage-error "${LM_GATE_STAGE_ERROR:-}"');
    expect(recordQa).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-qa.json');
    expect(recordQa).toContain('bun ci/record.mjs merge --record "$LM_RECORD"');
    // Unit 失敗、Browser 在評估前失敗時，post 以 stage-error 記錄「QA」未通過。
    expect(unit).toMatch(/gate: failed,[\s\S]*stageError: failed \? qaStageError\('Unit Tests'\)/);
    expect(browser).toMatch(/LM_QA_GATE_RECORDED != 'true'[\s\S]*stageError: qaStageError\('Browser Tests'\)/);
  });

  test('post：always 於 120 秒內銷毀資料庫；失敗時遮罩並封存截圖、trace 與伺服器日誌（Req 4.2、5.6）', () => {
    // always 只呼叫該階段的 post 函式（Components 第 22.1 節），函式的第一個敘述是 destroyEphemeralDb()。
    for (const [name, fn] of [['Unit Tests', 'unitTestsPostAlways'], ['Browser Tests', 'browserTestsPostAlways']]) {
      const block = stageBlock(name);
      const post = block.slice(at(block, 'post {'));
      expect(post).toMatch(new RegExp(`always\\s*\\{\\s*script\\s*\\{\\s*${fn}\\(\\)`));
      expect(functionBody(`void ${fn}()`)).toMatch(new RegExp(`^void ${fn}\\(\\) \\{\\s*destroyEphemeralDb\\(\\)`));
      expect(post).toMatch(/cleanup\s*\{\s*script\s*\{\s*removeEphemeralDbSecrets\(\)/);
    }
    expect(destroyDb).toContain("timeout(time: 120, unit: 'SECONDS')");
    expect(destroyDb).toContain('docker rm -fv');
    expect(destroyDb).toContain('docker network rm "$LM_EDB_NET"');
    expect(destroyDb).toContain('label=lm.ci.edb=$LM_EDB_RUN');
    expect(browser).toMatch(/unsuccessful\s*\{[\s\S]*archiveBrowserEvidence\(\)/);
    const evidence = functionBody('void archiveBrowserEvidence()');
    for (const s of ['test-results', 'reports/server.log', 'bun ci/scrub.mjs --secrets "$LM_EDB_DIR/scrub-secrets.json"', 'archiveArtifacts']) {
      expect(evidence).toContain(s);
    }
    // playwright.config.js 在失敗時保留截圖與 trace，目錄依 project（desktop／mobile）區分。
    const pw = readFileSync(resolve(root, 'playwright.config.js'), 'utf8');
    expect(pw).toContain("screenshot: 'only-on-failure'");
    expect(pw).toContain("trace: 'retain-on-failure'");
    expect(pw).toContain('retries: 0');
  });
});

describe('Security Scan 階段（Req 6.1–6.9、23.1、23.3、23.5）', () => {
  const sec = stageCode('Security Scan');
  const prepare = functionBody('void prepareScanSources()');
  const runScan = functionBody('void runScan(String what, String report, String script)');
  const recordGate = functionBody('int recordSecurityGate(String stageError)');
  const gateFn = functionBody('Map securityGate(String evaluationText, List scanErrors, String stageError, String commit, List reports)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const scanRuns = [...dockerRunsIn(sec), ...dockerRunsIn(functionBody('void scannerVersions()'))];

  test('位於 Browser Tests 之後；依序 Gitleaks（dir、git）→ osv-scanner → Trivy → Semgrep → normalize → evaluate → 關卡', () => {
    expect(code.indexOf("stage('Security Scan')")).toBeGreaterThan(code.indexOf("stage('Browser Tests')"));
    const order = [
      'pullImages(scannerImages())', 'prepareScanSources()', 'scannerVersions()',
      "'gitleaks-dir.json'", "'gitleaks-git.json'", "'osv.json'", "'trivy-node-modules.json'", "'semgrep.json'",
      'bun ci/policy/normalize.mjs', 'bun ci/policy/evaluate.mjs', "recordSecurityGate('')",
    ].map((s) => at(sec, s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sec).toMatch(/recordSecurityGate\(''\) != 0\)\s*\{\s*error\(/);
  });

  test('掃描器映像以 LAN Registry 的 @sha256: digest 固定，且於拉取前驗證（Req 3.1、6.8）', () => {
    for (const name of ['LM_GITLEAKS_IMAGE', 'LM_OSV_SCANNER_IMAGE', 'LM_TRIVY_IMAGE', 'LM_SEMGREP_IMAGE']) {
      const ref = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1];
      expect(ref).toMatch(/^registry\.our-littlemoments\.com:8443\/[^@\s]+@sha256:[0-9a-f]{64}$/);
      expect(functionBody('List scannerImages()')).toContain(`env.${name}`);
    }
    expect(functionBody('List scannerImages()')).toContain('isPinnedImage(s)');
    expect(functionBody('String buildImageDigest()')).toContain('isPinnedImage(ref)');
  });

  test('Gitleaks：受版本控制檔案（dir）與 Git 歷史（git --log-opts），一律 --redact、JSON 報告、無 verbose（Req 6.1、6.4）', () => {
    const gitleaks = scanRuns.filter((c) => c.includes('"$LM_GITLEAKS_IMAGE"') && !c.includes(' version'));
    expect(gitleaks.length).toBe(2);
    const [dir, git] = gitleaks;
    expect(dir).toMatch(/"\$LM_GITLEAKS_IMAGE"\s*\\\n\s*dir /);
    expect(git).toMatch(/"\$LM_GITLEAKS_IMAGE"\s*\\\n\s*git /);
    expect(git).toContain('--log-opts="$LM_GITLEAKS_LOG_OPTS" /repo');
    for (const cmd of gitleaks) {
      expect(cmd).toMatch(/\s--redact\s/);
      expect(cmd).toContain('--report-format json');
      expect(cmd).toContain('--exit-code 0');
      expect(cmd).not.toMatch(/\s(-v|--verbose)\b/);
      expect(cmd).toContain('--network none');
    }
    // 受版本控制檔案以暫存 index 取出（不套用 export-ignore）；repo 內的掃描器設定／忽略檔不生效。
    expect(prepare).toContain('git read-tree "$GIT_COMMIT_FULL"');
    expect(prepare).toContain('git checkout-index --all --force --prefix="$LM_SCAN_DIR/tree/"');
    for (const f of ['.gitleaks.toml', '.gitleaksignore', 'osv-scanner.toml', '.semgrepignore', '.trivyignore']) expect(prepare).toContain(f);
    expect(prepare).toContain('git init -q --bare "$LM_SCAN_DIR/history.git"');
    // Gitleaks 原始報告不保留（只保留 normalize 後不含秘密的結果）。
    expect(sec).toContain('rm -f "$LM_SCAN_DIR/out/gitleaks-dir.json" "$LM_SCAN_DIR/out/gitleaks-git.json"');
  });

  test('Git 歷史範圍：Untrusted_PR 用 merge base，其他從 LM_GITLEAKS_HISTORY_BASE 或其後已驗證的 GIT_PREVIOUS_SUCCESSFUL_COMMIT 開始，沒有完整歷史（Req 6.1、6.10）', () => {
    // Secret_History_Baseline：environment 恰有一個 40 個小寫十六進位字元的常數，不是建置參數、不經 params.* 或 withEnv 覆寫（Req 23.4）。
    const environment = functionBody('  environment {');
    expect(environment.match(/^\s*LM_GITLEAKS_HISTORY_BASE\s*=\s*'[0-9a-f]{40}'\s*$/gm)?.length).toBe(1);
    expect(code.match(/\bLM_GITLEAKS_HISTORY_BASE\s*=\s*'/g)?.length).toBe(1);
    expect(/LM_GITLEAKS_HISTORY_BASE\s*=\s*'([^']+)'/.exec(environment)?.[1]).toBe('c08447436cb3db000b577a3de28f8be8acbee540');
    expect(structure).not.toMatch(/\bparameters\s*[{(]/);
    expect(code).not.toMatch(/params\.[\w.?]*LM_GITLEAKS_HISTORY_BASE|params\[\s*['"]LM_GITLEAKS_HISTORY_BASE/);
    expect(code).not.toMatch(/LM_GITLEAKS_HISTORY_BASE=|env\.LM_GITLEAKS_HISTORY_BASE\s*=/);
    expect(prepare).toContain('floor="${LM_GITLEAKS_HISTORY_BASE:-}"');
    expect(prepare).toContain('git merge-base --is-ancestor "$floor" "$head"');
    expect(prepare).toContain('git merge-base --is-ancestor "$floor" "$prev"');
    // 不再有只輸出 $head 的完整歷史分支（Jenkinsfile 原文的 '%s\\n'）。
    expect(prepare).not.toContain(String.raw`printf '%s\\n' "$head"`);
    // 非 PR 失敗時的固定訊息（不含任何 SHA 或其他值）。
    expect(prepare).toContain("'Gitleaks（Git 歷史）無法決定掃描範圍（LM_GITLEAKS_HISTORY_BASE 無效或不是建置 commit 的祖先），歷史掃描未完成'");
    expect(prepare).toContain("env.LM_TRIGGER_KIND == 'pull_request'");
    expect(prepare).toContain('validBranchName(target)');
    // 非 PR 建置時兩者皆為空、Jenkins 不傳給 sh（Components 第 24.4 節），以 ${X:-} 展開。
    expect(prepare).toContain('git merge-base "${LM_SCAN_BASE_REF:-}" "$head"');
    expect(prepare).toContain("'refs/remotes/origin/' + target");
    expect(prepare).toContain('"+refs/heads/${LM_SCAN_FETCH_TARGET:-}:refs/remotes/origin/${LM_SCAN_FETCH_TARGET:-}"');
    // "LM_SCAN_FETCH_TARGET=${target}" 的空值來自前一行的三元運算，tests/ci-jenkinsfile-shell-env.test.js 的規則 1 無法辨識，在此固定。
    expect(prepare).toContain('if [ -n "${LM_SCAN_FETCH_TARGET:-}" ]; then');
    expect(prepare).toContain('git fetch --unshallow');
    expect(prepare).toContain("grep -Eqx '[0-9a-f]{40}'");
    expect(prepare).toContain('git merge-base --is-ancestor "$prev" "$head"');
    expect(prepare).toContain('${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}');
    // Groovy 端再驗證範圍格式，PR 必須是 base..head，且結尾必須是建置 commit。
    expect(prepare).toContain('range ==~ /^[0-9a-f]{40}\\.\\.[0-9a-f]{40}$/');
    expect(prepare).toContain('range ==~ /^([0-9a-f]{40}\\.\\.)?[0-9a-f]{40}$/');
    expect(prepare).toContain('range.endsWith(sha)');
    // 無法決定範圍 → 歷史掃描未完成（記錄原因），關卡未通過。
    expect(prepare).toMatch(/LM_GITLEAKS_LOG_OPTS = ''\s*\n\s*lmScanErrors << /);
    expect(functionBody('boolean validBranchName(String name)')).toContain("!name.contains('..')");
  });

  // 腳本行為（design.md Components 第 27.6 節）：在臨時 repository 建立 A–B–C–D 與自 A 分岔的 X，
  // 執行 Jenkinsfile 的「Gitleaks history range」腳本。Windows 經 WSL 的 dash／sh；沒有 POSIX sh 時略過。
  const SH = findPosixShell();
  const describeSh = SH ? describe : describe.skip;
  describeSh(SH ? `Gitleaks history range 腳本（${SH.label}、git）` : 'Gitleaks history range 腳本（略過：找不到 POSIX sh 與 git）', () => {
    const m = /label: 'Gitleaks history range', returnStdout: true, script: '''([\s\S]*?)'''/.exec(prepare);
    const rangeScript = groovyUnescape(m?.[1] ?? '').replace(/\r/g, '');
    // 每個案例：名稱、LM_SCAN_BASE_REF、LM_GITLEAKS_HISTORY_BASE、GIT_PREVIOUS_SUCCESSFUL_COMMIT（符號在 WSL 端換成 SHA；UNSET 表示不設定）。
    const cases = {
      'prev 為空': ['', 'B', 'UNSET'],
      'prev 為空字串': ['', 'B', ''],
      'prev 為起點的後代': ['', 'B', 'C'],
      'prev 等於起點': ['', 'B', 'B'],
      'prev 比起點舊': ['', 'B', 'A'],
      'prev 不是 head 的祖先': ['', 'B', 'X'],
      'prev 不是 40 hex': ['', 'B', 'SHORT'],
      'prev 不存在': ['', 'B', 'MISSING'],
      '起點不是 40 hex': ['', 'SHORT', 'C'],
      '起點為大寫十六進位': ['', 'UPPER', 'C'],
      '起點未設定': ['', 'UNSET', 'C'],
      '起點不存在': ['', 'MISSING', 'C'],
      '起點不是 head 的祖先': ['', 'X', 'C'],
      '起點等於 head（空範圍）': ['', 'D', 'UNSET'],
      'PR：merge base 分支不變': ['refs/heads/side', 'MISSING', 'C'],
      'PR：取不到 merge base': ['refs/heads/nope', 'B', 'C'],
    };
    const expected = {
      'prev 為空': 'B..D', 'prev 為空字串': 'B..D', 'prev 為起點的後代': 'C..D', 'prev 等於起點': 'B..D',
      'prev 比起點舊': 'B..D', 'prev 不是 head 的祖先': 'B..D', 'prev 不是 40 hex': 'B..D', 'prev 不存在': 'B..D',
      '起點不是 40 hex': '', '起點為大寫十六進位': '', '起點未設定': '', '起點不存在': '', '起點不是 head 的祖先': '',
      '起點等於 head（空範圍）': 'D..D', 'PR：merge base 分支不變': 'A..D', 'PR：取不到 merge base': '',
    };
    let results = null;
    let shas = null;
    function runAll() {
      if (results) return;
      const dir = mkdtempSync(join(tmpdir(), 'lm-gitleaks-range-'));
      try {
        writeFileSync(join(dir, 'range.sh'), rangeScript);
        writeFileSync(join(dir, 'driver.sh'), RANGE_DRIVER);
        const names = Object.keys(cases);
        const args = names.flatMap((n) => cases[n]);
        const argv = [...SH.prefix, SH.sh, SH.toPath(join(dir, 'driver.sh')), SH.sh, SH.toPath(join(dir, 'range.sh')),
          ...args.map((a) => (a === '' ? 'EMPTY' : a))];
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000 });
        expect({ status: r.status, stderr: r.stderr ?? '' }).toEqual({ status: 0, stderr: '' });
        const lines = r.stdout.replace(/\r/g, '').split('\n');
        shas = Object.fromEntries(lines.filter((l) => /^[ABCDX]=/.test(l)).map((l) => l.split('=')));
        const outs = lines.filter((l) => l.startsWith('out=')).map((l) => l.slice(4));
        expect(outs.length).toBe(names.length);
        results = Object.fromEntries(names.map((n, i) => [n, outs[i]]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const sub = (s) => s.replace(/\b[ABCDX]\b/g, (c) => shas[c]);

    test('腳本取出成功且含起點的檢查', () => {
      expect(rangeScript).toContain('floor="${LM_GITLEAKS_HISTORY_BASE:-}"');
      expect(rangeScript).not.toMatch(/printf '%s\\n' "\$head"/);
    });
    for (const name of Object.keys(cases)) {
      test(`${name} → ${expected[name] || '沒有輸出（歷史掃描未完成）'}`, () => {
        runAll();
        expect(Object.keys(shas).sort()).toEqual(['A', 'B', 'C', 'D', 'X']);
        expect(results[name]).toBe(expected[name] ? sub(expected[name]) : '');
      });
    }
  });

  test('osv-scanner v2（bun.lock、--all-packages）、Trivy node_modules 交叉掃描、Semgrep（ci/semgrep/run.sh）（Req 6.2、6.3）', () => {
    expect(sec).toContain('scan source --lockfile=/src/bun.lock --all-packages --format json --output-file "/out/$LM_SCAN_REPORT"');
    expect(sec).toContain('rootfs --scanners vuln --list-all-pkgs --format json --output "/out/$LM_SCAN_REPORT"');
    expect(sec).toContain('--mount "type=bind,src=$WORKSPACE/node_modules,dst=/scan/node_modules,readonly"');
    expect(sec).toContain('--db-repository "$LM_TRIVY_DB_REPOSITORY"');
    expect(sec).toContain('ci/semgrep/run.sh scan "/out/$LM_SCAN_REPORT"');
    // ci/semgrep/run.sh 的用法與此一致。
    expect(readFileSync(resolve(root, 'ci/semgrep/run.sh'), 'utf8')).toContain('ci/semgrep/run.sh scan <out.json>');
  });

  test('每項掃描 15 分鐘逾時；錯誤、逾時或缺少輸入時刪除報告並記錄未完成（Req 6.8）', () => {
    const scans = scanRuns.filter((c) => !c.includes('-version-'));
    expect(scans.length).toBe(5);
    expect([...sec.matchAll(/timeout --kill-after=30 900 docker run /g)].length).toBe(5);
    expect(runScan).toContain("timeout(time: 17, unit: 'MINUTES')");
    expect(runScan).toMatch(/rc != 0\)\s*\{\s*discardScan\(\)/);
    expect(runScan).toMatch(/catch \(Exception e\)\s*\{[\s\S]*discardScan\(\)\s*\n\s*throw e/);
    expect(functionBody('void discardScan()')).toContain('rm -f "$LM_SCAN_DIR/out/$LM_SCAN_REPORT"');
    // 只有 osv-scanner（1 = 有漏洞）與 Semgrep（1 = 有結果）把結束碼 1 視為完成；其他非零皆為未完成。
    expect([...sec.matchAll(/if \[ "\$rc" -eq 1 \]; then rc=0; fi/g)].length).toBe(2);
    // 評估無法執行（結束碼 2）也記錄為未完成。
    expect(sec).toMatch(/evalRc != 0 && evalRc != 1\)\s*\{\s*lmScanErrors << /);
  });

  test('工具版本：只有 Semgrep 關閉版本檢查；60 秒逾時、|| true 與取不到版本時為 null 的處理不變（Req 6.7、6.8）', () => {
    const versions = functionBody('void scannerVersions()');
    const calls = versions.split('\n').map((l) => l.trim()).filter((l) => /^v [a-z-]+ /.test(l));
    expect(calls).toEqual([
      'v gitleaks "$LM_GITLEAKS_IMAGE" version',
      'v osv-scanner "$LM_OSV_SCANNER_IMAGE" --version',
      'v trivy "$LM_TRIVY_IMAGE" --version',
      'v semgrep -e SEMGREP_ENABLE_VERSION_CHECK=0 --entrypoint semgrep "$LM_SEMGREP_IMAGE" --version',
    ]);
    expect([...versions.matchAll(/SEMGREP_ENABLE_VERSION_CHECK/g)].length).toBe(1);
    expect([...versions.matchAll(/timeout --kill-after=10 60 docker run /g)].length).toBe(1);
    expect(versions).toContain('--network none "$@" 2>/dev/null');
    expect(versions).toContain('| head -n 1 > "$LM_SCAN_DIR/out/$tool.version" || true');
    expect(versions).toMatch(/\n\s*exit 0\n/);
    // 版本步驟在 secStep('無法取得掃描工具版本') 與 secStep('') 之間（步驟失敗時記錄為掃描未完成）。
    expect(sec).toMatch(/secStep\('無法取得掃描工具版本'\)\s*\n\s*scannerVersions\(\)\s*\n\s*secStep\(''\)/);
  });

  test('掃描器容器：非 root、唯讀根檔案系統、--cap-drop ALL、no-new-privileges、建置標籤；寫入只限掃描暫存目錄', () => {
    expect(scanRuns.length).toBe(6);
    for (const cmd of scanRuns) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.scan=$LM_SCAN_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).toMatch(/--network (none|bridge)\b/);
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) {
        const writable = !m[1].endsWith(',readonly');
        if (writable) expect(m[1]).toMatch(/^type=bind,src=\$LM_SCAN_DIR\/[a-z-]+,dst=\/(out|cache)$/);
      }
    }
    // 只有需要漏洞資料庫的 osv-scanner 與 Trivy 可連網。
    const networked = scanRuns.filter((c) => c.includes('--network bridge'));
    expect(networked.map((c) => /"\$(LM_\w+_IMAGE)"/.exec(c)?.[1]).sort()).toEqual(['LM_OSV_SCANNER_IMAGE', 'LM_TRIVY_IMAGE']);
  });

  test('拉取帳號只在 withCredentials 內、經 set +x 腳本與 docker -e NAME 傳遞（Req 15.1、15.2）', () => {
    // pullImages、Trivy（node_modules）、13.5 起的 Trivy（App_Image）、13.6 起的 Staging 部署前 cosign verify，
    // 與 13.7 起 Release_Tag 的唯讀 Registry 操作（releaseRegistry：crane digest／config、cosign verify／verify-attestation）五個腳本使用拉取帳號。
    const regScripts = tripleScripts.filter((s) => /LM_REG_PASSWORD|TRIVY_PASSWORD/.test(s));
    expect(regScripts.length).toBe(5);
    for (const s of regScripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
    expect(sec).toContain('-e TRIVY_USERNAME -e TRIVY_PASSWORD');
    expect(sec).not.toMatch(/-e TRIVY_PASSWORD=/);
    expect(sec).toMatch(/withCredentials\(\[usernamePassword\([\s\S]*?runScan\('Trivy/);
  });

  test('normalize／evaluate 參數與 CLI 一致；「安全」關卡寫入 Build_Record，階段失敗時 post 記錄未通過（Req 6.7、23.1、23.3、23.5）', () => {
    const specs = /for spec in ([^;]+);/.exec(sec)?.[1].trim().split(/\s+/) ?? [];
    expect(specs.map((s) => s.split(':')[0])).toEqual(['gitleaks', 'gitleaks', 'osv-scanner', 'trivy', 'semgrep']);
    const evalReports = /--reports ([^\\\n]+)/.exec(sec)?.[1].trim().split(/\s+/) ?? [];
    expect(evalReports).toEqual(specs.map((s) => `reports/security/${s.split(':')[1]}.json`));
    expect(sec).toContain('--exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_SCAN_TODAY"');
    // 寫入 Build_Record 的步驟由 writeSecurityGate 共用（Security Scan 與含 DAST 的評估），路徑經環境變數傳入。
    expect(recordGate).toContain("writeSecurityGate(reports, 'reports/security/evaluation.json', errors, stageError,");
    expect(recordGate).toContain("'reports/gate-security.json', 'reports/security-record-patch.json')");
    const writeGate = functionBody('int writeSecurityGate(Map reports, String evaluationPath, List errors, String stageError, String gateFile, String patchFile)');
    expect(writeGate).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_SECURITY_GATE_FILE"');
    expect(writeGate).toContain('bun ci/record.mjs merge --record "$LM_RECORD" --patch "$LM_SECURITY_GATE_PATCH"');
    expect(writeGate).toContain('"LM_SECURITY_GATE_FILE=${gateFile}", "LM_SECURITY_GATE_PATCH=${patchFile}"');
    expect(writeGate).toMatch(/rc != 0\)\s*\{\s*error\(/);
    expect(gateFn).toContain("gate: '安全'");
    expect(gateFn).toMatch(/failedRun \|\| !incomplete\.isEmpty\(\)\)\s*\{\s*status = 'error'/);
    expect(sec).toMatch(/LM_SECURITY_GATE_RECORDED != 'true'[\s\S]*recordSecurityGate\(secStageError\(\)\)/);
    expect(sec).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupSecurityScan\(\)/);
    // Build_Record 報告鍵通過白名單。
    const keys = Object.fromEntries([...recordGate.matchAll(/(\w+): '(reports\/security\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(keys).sort()).toEqual(['gitleaks', 'gitleaksHistory', 'osv', 'securityEvaluation', 'semgrep', 'trivyNodeModules']);
    const rec = createRecord({
      job: 'ci/little-moments/PR-1', number: 1, url: 'https://jenkins.invalid/job/1/',
      commit: 'a'.repeat(40), trigger: 'pull_request', ref: 'PR-1', buildImageDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(validateRecord(mergeRecord(rec, { reports: keys })).ok).toBe(true);
  });
});

describe('Trusted_Ref 專用階段：Migration Compatibility 與 DAST（Req 7、10.10、10.11、12.5、12.8、12.9）', () => {
  const compat = stageCode('Migration Compatibility');
  const dast = stageCode('DAST');
  const runDast = functionBody('void runDast()');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 1, url: 'https://jenkins.invalid/job/1/',
    commit: 'a'.repeat(40), trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });

  test('緊接 Security Scan 之後依序為 Migration Compatibility → DAST，且只在 Trusted_Ref 規劃中執行（Req 2.8、7.1）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(7, 10)).toEqual([STAGE.SECURITY, STAGE.MIGRATION_COMPAT, STAGE.DAST]);
    expect(compat).toMatch(/when\s*\{\s*expression\s*\{\s*planned\('Migration Compatibility'\) && env\.LM_TRUSTED == 'true'\s*\}/);
    expect(dast).toMatch(/when\s*\{\s*expression\s*\{\s*planned\('DAST'\) && env\.LM_TRUSTED == 'true'\s*\}/);
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    expect(TRUSTED_ONLY_STAGES).toContain(STAGE.MIGRATION_COMPAT);
    expect(TRUSTED_ONLY_STAGES).toContain(STAGE.DAST);
    for (const t of [{ event: 'pull_request', ref: 'feature', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature' }]) {
      const { stages } = planStages(t);
      expect(stages).not.toContain(STAGE.MIGRATION_COMPAT);
      expect(stages).not.toContain(STAGE.DAST);
    }
    for (const t of [{ event: 'push', ref: 'main' }, { event: 'tag', ref: 'v1.2.3' }]) {
      const { stages } = planStages(t);
      expect(stages.indexOf(STAGE.BROWSER)).toBeLessThan(stages.indexOf(STAGE.DAST));
      expect(stages.indexOf(STAGE.MIGRATION_COMPAT)).toBeGreaterThan(-1);
    }
    // 瀏覽器測試未全部通過時不執行 DAST（Req 7.1）。
    expect(dast).toMatch(/LM_BROWSER_DONE != 'true'\)\s*\{[\s\S]*?error\(/);
  });

  test('Migration Compatibility：lint → git describe → 舊映像遷移 → 新增遷移 → 舊映像啟動 → 合成資料 → Smoke_Test（Req 12.5、12.9）', () => {
    inOrder(compat, [
      'bun scripts/lint-migrations.mjs', "'+refs/tags/v*:refs/tags/v*'", 'git describe --tags --abbrev=0',
      'git diff --name-only --no-renames "refs/tags/$LM_COMPAT_TAG" "$GIT_COMMIT_FULL" -- migrations/',
      'pullReleaseImage(tag)', "startEphemeralDb('compat')", 'writeAppSecrets()', '/app/server/migrate.js',
      "migrateEphemeralDb('reports/migration-compat-new-migrate.log')", 'docker run -d --name "$LM_COMPAT_APP"',
      "seedTestApp('reports/migration-compat')", 'bun scripts/smoke.mjs', "recordMigrationCompat('pass', '')",
    ]);
    expect(compat).toMatch(/lintRc != 0\)\s*\{\s*error\(/);
    expect(compat).toMatch(/oldRc != 0\)\s*\{\s*error\(/);
    expect(compat).toMatch(/newRc != 0\)\s*\{\s*error\(/);
    expect(compat).toMatch(/smokeRc != 0\)\s*\{\s*error\(/);
    // 只看本次 commit 的祖先，Release_Tag 建置不會選到自己的 Tag；結果須通過 Release_Tag 格式驗證。
    expect(compat).toContain('base="$GIT_COMMIT_FULL^1"');
    expect(compat).toContain("--match 'v[0-9]*.[0-9]*.[0-9]*'");
    expect(compat).toMatch(/!isReleaseTag\(tag\)\)\s*\{\s*error\(/);
    // 無 Tag 或無遷移變更：記錄略過原因後結束，不拉取映像、不建立資料庫（Req 12.5）。
    const skips = [...compat.matchAll(/recordMigrationCompat\('skipped', [^\n]+\n\s*echo [^\n]+\n\s*return\n/g)];
    expect(skips.length).toBe(2);
    for (const s of skips) expect(s.index).toBeLessThan(at(compat, 'pullReleaseImage(tag)'));
    // 舊映像只以 pullReleaseImage 解析出的 digest 執行；兩個容器都在本階段的 --internal 網路內。
    expect([...compat.matchAll(/"\$LM_COMPAT_IMAGE"/g)].length).toBe(2);
    for (const cmd of dockerRunsIn(compat)) {
      expect(cmd).toContain('--network "$LM_EDB_NET"');
      expect(cmd).toContain('--label "lm.ci.edb=$LM_EDB_RUN"');
      expect(cmd).toContain('--cap-drop ALL');
      expect(cmd).toContain('--read-only');
    }
    // post：銷毀資料庫（含依 label 移除 App 容器）、失敗時記錄失敗原因，最後刪除秘密檔。
    // always 只呼叫 migrationCompatibilityPostAlways()（Components 第 22.1 節），cleanup 在其後。
    const block = stageBlock('Migration Compatibility');
    const post = block.slice(at(block, 'post {'));
    inOrder(post, ['always {', 'migrationCompatibilityPostAlways()', 'cleanup {', 'removeEphemeralDbSecrets()']);
    inOrder(functionBody('void migrationCompatibilityPostAlways()'), ['saveContainerLog(env.LM_COMPAT_APP', 'destroyEphemeralDb()', "recordMigrationCompat('fail', compatStageError())"]);
  });

  test('Release_Tag 格式與 ci/policy/tag.mjs 一致；舊映像以版本標籤拉取後立即解析為 digest', async () => {
    const { parseReleaseTag } = await import('../ci/policy/tag.mjs');
    const src = /==~ \/(\^v[^\n]+\$)\//.exec(functionBody('boolean isReleaseTag(String tag)'))?.[1];
    const re = new RegExp(src);
    for (const t of ['v0.0.0', 'v1.2.3', 'v999999.0.1', 'v01.2.3', 'v1.2', 'v1.2.3-rc1', '1.2.3', 'v1234567.0.0', 'v1.2.3+x']) {
      expect(re.test(t)).toBe(parseReleaseTag(t) !== null);
    }
    const pull = functionBody('String pullReleaseImage(String tag)');
    inOrder(pull, ['!repo.startsWith(registry', 'isReleaseTag(tag)', 'pullImages([tagged])', '{{range .RepoDigests}}', "!isPinnedImage(ref) || !ref.startsWith(repo + '@sha256:')"]);
    // pullImages 只額外接受 LM_IMAGE_REPO 的 Release_Tag 版本標籤，且 LM_IMAGE_REPO 必須位於同一 Registry。
    const pullImagesFn = functionBody('void pullImages(List refs)');
    expect(pullImagesFn).toContain('"$LM_IMAGE_REPO":v[0-9]*.[0-9]*.[0-9]*)');
    expect(pullImagesFn).toContain('"$registry"/*@sha256:*) ;;');
    expect(/LM_IMAGE_REPO\s*=\s*'([^']+)'/.exec(source)?.[1]).toBe('registry.our-littlemoments.com:8443/little-moments');
  });

  test('遷移相容性結果寫入 Build_Record：狀態、Release_Tag、digest、遷移檔、原因與失敗的 Smoke_Test 項目（Req 12.5、12.8）', () => {
    const fn = functionBody('void recordMigrationCompat(String status, String reason)');
    for (const k of ['status: status', 'releaseTag:', 'image:', 'migrations:', 'reason:', 'failedSmokeSteps:']) expect(fn).toContain(k);
    expect(fn).toContain('reports.migrationCompat = compat');
    expect(fn).toContain('bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/migration-compat-record-patch.json');
    const paths = Object.fromEntries([...fn.matchAll(/(\w+): '(reports\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(paths)).toContain('lintMigrations');
    const patch = {
      reports: {
        ...paths,
        migrationCompat: {
          status: 'fail', releaseTag: 'v1.2.3', image: `registry.lan.example:8443/little-moments@sha256:${'c'.repeat(64)}`,
          migrations: ['migrations/0002_add_notes.sql'], reason: 'v1.2.3 的 App_Image 在新增遷移後 Smoke_Test 失敗',
          failedSmokeSteps: ['trips（狀態碼 500，status）'],
        },
      },
    };
    expect(validateRecord(mergeRecord(base(), patch)).ok).toBe(true);
    const skipped = { reports: { migrationCompat: { status: 'skipped', releaseTag: '', image: '', migrations: [], reason: '尚無 Release_Tag', failedSmokeSteps: [] } } };
    expect(validateRecord(mergeRecord(base(), skipped)).ok).toBe(true);
  });

  test('DAST：60 分鐘上限；逾時視為失敗、使用者中止則重新拋出（Req 7.4、7.5）', () => {
    expect(dast).toMatch(/timeout\(time: 60, unit: 'MINUTES'\)\s*\{\s*runDast\(\)\s*\}/);
    expect(dast).toMatch(/catch \(org\.jenkinsci\.plugins\.workflow\.steps\.FlowInterruptedException e\)\s*\{[\s\S]*?error\([\s\S]*?throw e/);
    expect(dast).toMatch(/recordDastSecurityGate\(''\) != 0\)\s*\{\s*error\(/);
    // post：先停止 ZAP（60 秒內）→ 保存日誌 → 銷毀 Test_Environment 與資料庫 → 未記錄時評估並記錄關卡 → 刪除秘密檔。
    // always 只呼叫 dastPostAlways()（Components 第 22.1 節），cleanup 在其後。
    const block = stageBlock('DAST');
    const post = block.slice(at(block, 'post {'));
    inOrder(post, ['always {', 'dastPostAlways()', 'cleanup {', 'removeEphemeralDbSecrets()']);
    inOrder(functionBody('void dastPostAlways()'), ['stopDastScanner()', 'saveContainerLog(env.LM_DAST_APP', 'destroyEphemeralDb()', 'evaluateDastReports()', 'recordDastSecurityGate(dastStageError())']);
    const stop = functionBody('void stopDastScanner()');
    expect(stop).toContain("timeout(time: 60, unit: 'SECONDS')");
    expect(stop).toContain('label=lm.ci.dast=$LM_EDB_RUN');
  });

  test('DAST 順序：目標驗證 → Test_Environment → 隔離探測 → 安全測試套件 → ZAP → 評估（Req 7.2、7.3、7.6、7.9）', () => {
    inOrder(runDast, [
      'dastImages()', 'dastProbeTargets()', 'pullImages(images)', "startEphemeralDb('dast')", 'bun ci/dast/targets.mjs',
      'writeAppSecrets()', "migrateEphemeralDb('reports/dast/migrate.log')", 'docker run -d --name "$LM_DAST_APP"',
      "seedTestApp('reports/dast/app')", '/probe/isolation-probe.sh', 'bun scripts/security-suite.mjs', 'zap.sh', 'evaluateDastReports()',
    ]);
    // Target_Allowlist 只含本次 Test_Environment 的 origin；ZAP 只執行驗證通過後產生的計畫。
    expect(runDast).toContain('--allowlist "$LM_DAST_ORIGIN"');
    expect(runDast).toContain('--render reports/dast/zap-plan.yaml --out reports/dast/targets.json');
    expect(runDast).toMatch(/targetsRc != 0\)\s*\{[\s\S]*?lmDastErrors\.addAll\(dastTargetProblems\(result\)\)\s*\n\s*error\(/);
    expect(runDast).toContain('cp reports/dast/zap-plan.yaml "$zapdir/zap-plan.yaml"');
    expect(runDast).toContain('-autorun /zap/wrk/zap-plan.yaml');
    expect(runDast).toContain("env.LM_DAST_ORIGIN = \"http://${env.LM_DAST_APP}:5173\"");
    // 隔離探測在 Test_Environment 的網路命名空間內，只允許 Ephemeral_Database；可連線位址寫入關卡（Req 7.9）。
    expect(runDast).toContain('--network "container:$LM_DAST_APP"');
    expect(runDast).toContain('--allow "$LM_EDB_HOST:5432"');
    expect(runDast).toMatch(/probeRc == 1\)\s*\{\s*lmDastErrors\.addAll\(isolationReachable\([\s\S]*?\)\)\s*\n\s*error\(/);
    expect(runDast).toMatch(/probeRc != 0\)\s*\{[\s\S]*?error\(/);
    // ZAP 異常結束、逾時、未產生報告或 Test_Environment 停止 → 失敗（Req 7.10）。
    expect(runDast).toMatch(/zapRc == 124 \|\| zapRc == 137\)\s*\{[\s\S]*?error\(/);
    expect(runDast).toMatch(/zapRc != 0\)\s*\{[\s\S]*?error\(/);
    expect([...runDast.matchAll(/!containerRunning\(env\.LM_DAST_APP\)\)\s*\{[\s\S]*?error\(/g)].length).toBe(2);
  });

  test('ZAP：digest 固定、--internal 網路、速率 20 rps；ZAP 計畫通過 ci/dast/targets.mjs 驗證（Req 7.2、7.4）', async () => {
    const ref = /LM_ZAP_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(ref).toMatch(/^registry\.our-littlemoments\.com:8443\/[^@\s]+@sha256:[0-9a-f]{64}$/);
    expect(functionBody('List dastImages()')).toContain('isPinnedImage(ref)');
    for (const k of ['description=lm-dast', 'enabled=true', 'matchStr=.*', 'regex=true', 'reqsPerSec=20', 'groupBy=RULE']) {
      expect(runDast).toContain(`-config 'network.ratelimit.rules.rule(0).${k}'`);
    }
    expect(runDast).toContain('-cmd -silent');
    const { substituteVars, validateDastTargets, validateDastLimits } = await import('../ci/dast/targets.mjs');
    const plan = Bun.YAML.parse(readFileSync(resolve(root, 'ci/dast/zap-automation.yaml'), 'utf8'));
    const origin = `http://lm-edb-dast-${'0123456789abcdef'}-app:5173`;
    const rendered = substituteVars(plan, { DAST_TARGET_ORIGIN: origin, DAST_REPORT_DIR: '/zap/wrk' });
    expect(validateDastTargets(rendered, origin).ok).toBe(true);
    expect(validateDastLimits(rendered).ok).toBe(true);
    expect(validateDastTargets(rendered, 'http://lm-staging.lan').rejected.length).toBeGreaterThan(0);
  });

  test('DAST 容器：只在本階段網路、建置 label、--cap-drop ALL、no-new-privileges、不掛載可寫的工作目錄（Req 7.7）', () => {
    const runs = dockerRunsIn(runDast);
    expect(runs.length).toBe(3);
    for (const cmd of runs) {
      expect(cmd).toMatch(/--network "(\$LM_EDB_NET|container:\$LM_DAST_APP)"/);
      for (const flag of ['--label "lm.ci.edb=$LM_EDB_RUN"', '--label "lm.ci.build=$BUILD_TAG"', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--user "$(id -u):$(id -g)"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) {
        if (!m[1].endsWith(',readonly')) expect(m[1]).toBe('type=bind,src=$zapdir,dst=/zap/wrk');
      }
    }
    // Test_Environment：綁定 0.0.0.0 只在 --internal 網路內；Allowed_Hosts 只有本次 Test_Environment 名稱。
    const app = runs.find((c) => c.includes('scripts/serve.mjs'));
    expect(app).toContain('-e CAMPING_BIND_ADDRESS=0.0.0.0');
    expect(app).toContain('-e "CAMPING_ALLOWED_HOSTS=$LM_DAST_APP"');
    expect(app).toContain('--mount "type=bind,src=$WORKSPACE,dst=/app,readonly"');
    // 隔離探測目標：同主機 192.168.1.121 上所有已發布的連接埠（design.md 第 18.6 節），每項都通過格式檢查；
    // 主機名稱與未取代的佔位符不是 IP 位址字面值，格式檢查拒絕（fail closed）。
    const probeFn = functionBody('List dastProbeTargets()');
    const probeRe = new RegExp(/==~ \/(\^[^\n]+\$)\//.exec(probeFn)?.[1]);
    const targets = /LM_DAST_PROBE_TARGETS\s*=\s*'([^']+)'/.exec(source)?.[1].split(' ');
    expect(targets).toEqual([22, 80, 443, 81, 8080, 8081, 8082, 8090, 8443].map((p) => `192.168.1.121:${p}`));
    for (const t of targets) expect(probeRe.test(t)).toBe(true);
    for (const t of ['192.168.1.10:22', '[fd00::1]:443']) expect(probeRe.test(t)).toBe(true);
    for (const t of ['<deploy-host-ip>:22', 'deploy-host.lan.example:22', '192.168.1.121']) expect(probeRe.test(t)).toBe(false);
    expect(runDast).toContain('set -f');
  });

  test('安全測試套件以 Req 10.10 的非 loopback 設定在 --internal 網路內執行，失敗即中止（Req 7.6、10.10、10.11）', () => {
    const suite = runDast.slice(at(runDast, "dastStep('安全測試套件"), at(runDast, 'zap.sh'));
    expect(suite).toContain('inBuildImageOn(env.LM_EDB_NET)');
    expect(suite).toContain("'CAMPING_SECURITY_GROUPS=loopback,lan', 'CAMPING_SECURITY_LAN_BIND=0.0.0.0'");
    expect(suite).toContain('timeout --kill-after=30 900 bun scripts/security-suite.mjs');
    expect(suite).toMatch(/suiteRc != 0\)\s*\{\s*lmDastErrors << [^\n]+\n\s*error\(/);
    // scripts/security-suite.mjs 的 lan 組使用 CAMPING_SECURITY_LAN_BIND 並輸出 reports/security-junit.xml。
    const runner = readFileSync(resolve(root, 'scripts/security-suite.mjs'), 'utf8');
    expect(runner).toContain('process.env.CAMPING_SECURITY_LAN_BIND');
    expect(runner).toContain("resolve(reports, 'security-junit.xml')");
  });

  test('含 DAST 的「安全」關卡：靜態掃描 + ZAP + 安全測試套件一起評估並寫入 Build_Record（Req 7.8、7.11、23.5）', () => {
    const ev = functionBody('void evaluateDastReports()');
    expect(ev).toContain('bun ci/policy/normalize.mjs --tool zap --in reports/dast/zap-report.json --out reports/security/zap.json');
    expect(ev).toContain('bun ci/policy/normalize.mjs --tool security-suite --in reports/security-junit.xml --out reports/security/security-suite.json');
    const evalReports = /--reports ([^\\\n]+)/.exec(ev)?.[1].trim().split(/\s+/) ?? [];
    const staticReports = /--reports ([^\\\n]+)/.exec(stageCode('Security Scan'))?.[1].trim().split(/\s+/) ?? [];
    expect(evalReports).toEqual([...staticReports, 'reports/security/zap.json', 'reports/security/security-suite.json']);
    expect(ev).toContain('--out reports/security/evaluation-dast.json');
    expect(ev).toMatch(/rc != 0 && rc != 1\)\s*\{\s*lmDastErrors << /);
    const rec = functionBody('int recordDastSecurityGate(String stageError)');
    expect(rec).toContain("writeSecurityGate(reports, 'reports/security/evaluation-dast.json', errors, stageError,");
    expect(rec).toContain('lmDastErrors');
    const keys = Object.fromEntries([...rec.matchAll(/(\w+): '(reports\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(keys.zap).toBe('reports/dast/zap-report.json');
    for (const k of ['securitySuite', 'dastTargets', 'dastIsolation', 'securityEvaluationDast']) expect(keys[k]).toBeDefined();
    expect(validateRecord(mergeRecord(base(), { reports: keys })).ok).toBe(true);
  });

  test('Test_Environment 秘密只存在 0600 檔並以 --env-file／set +x 腳本載入（Req 15.2）', () => {
    const secrets = functionBody('void writeAppSecrets()');
    expect(secrets.indexOf("'''") > -1 && secrets.slice(secrets.indexOf("'''") + 3).trim().startsWith('set +x')).toBe(true);
    expect(secrets).toContain('umask 077');
    for (const f of ['app.env', 'setup.env', 'seed.env', 'smoke.env', 'scrub-secrets.json']) expect(secrets).toContain(`"$LM_EDB_DIR/${f}"`);
    const users = tripleScripts.filter((s) => /\$LM_EDB_DIR\/(app|setup|seed|smoke)\.env/.test(s));
    expect(users.length).toBeGreaterThanOrEqual(5);
    for (const s of users) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
    expect(code).not.toMatch(/-e\s+"?CAMPING_(SETUP_TOKEN|SMOKE_PASSWORD|DATABASE_PASSWORD)/);
  });
});

describe('main 專用的映像階段：Image Build → Image Scan → SBOM → Image Push → Image Sign（Req 15.1–15.3、16、17.1–17.6、21.2）', () => {
  const IMAGE_STAGES = [STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN];
  const blocks = Object.fromEntries(IMAGE_STAGES.map((n) => [n, stageCode(n)]));
  const build = blocks[STAGE.IMAGE_BUILD];
  const scan = blocks[STAGE.IMAGE_SCAN];
  const sbom = blocks[STAGE.SBOM];
  const push = blocks[STAGE.IMAGE_PUSH];
  const sign = blocks[STAGE.IMAGE_SIGN];
  const prepare = functionBody('void prepareImageWork()');
  const gateFn = functionBody('Map imageGate(String phase, String evaluationText, List errors, String stageError, String commit, List reports, Map facts)');
  const recordGate = functionBody('int recordImageGate(String phase, String stageError, boolean recordPass)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 1, url: 'https://jenkins.invalid/job/1/',
    commit: 'a'.repeat(40), trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });

  test('緊接 DAST 之後依序執行，且只在 main_push 的 Trusted 規劃中執行（Req 1.3、1.4、2.8）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(9, 15)).toEqual([STAGE.DAST, ...IMAGE_STAGES]);
    for (const n of IMAGE_STAGES) {
      expect(blocks[n]).toContain(`when {\n        expression { planned('${n}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }`);
      expect(blocks[n]).toMatch(/unsuccessful\s*\{\s*script\s*\{\s*imageStageFailed\('[^']+'\)/);
      expect(blocks[n]).toContain(`imageStageFailed('${n}')`);
    }
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    for (const n of IMAGE_STAGES) expect(TRUSTED_ONLY_STAGES).toContain(n);
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.slice(main.indexOf(STAGE.IMAGE_BUILD), main.indexOf(STAGE.IMAGE_SIGN) + 1)).toEqual(IMAGE_STAGES);
    expect(main.indexOf(STAGE.DAST)).toBeLessThan(main.indexOf(STAGE.IMAGE_BUILD));
    // Release_Tag 不重新建置（Req 1.4、16.1）；PR 與其他分支（含手動重跑）沒有任何映像階段（Req 2.8）。
    for (const t of [{ event: 'tag', ref: 'v1.2.3' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature', manual: true }]) {
      for (const n of IMAGE_STAGES) expect(planStages(t).stages).not.toContain(n);
    }
    expect(sign).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupImageWork\(\)/);
  });

  test('Image Build：QA 與安全（含 DAST）關卡通過後才建置；build-image.sh → image-smoke.sh，皆不使用憑證（Req 16.1、16.8、16.9）', () => {
    inOrder(build, [
      'requireQaAndSecurityPassed()', "env.LM_IMAGE_GATE_ELIGIBLE = 'true'", 'pullImages(imageToolImages())', 'prepareImageWork()',
      'bash ci/scripts/build-image.sh --commit "$GIT_COMMIT_FULL" --repo "$LM_IMAGE_REPO" --reports reports',
      "readFile('reports/image-ref.txt')", 'bash ci/scripts/image-smoke.sh --image "$LM_IMAGE_REF" --postgres-image "$LM_POSTGRES_IMAGE"',
    ]);
    const req = functionBody('void requireQaAndSecurityPassed()');
    for (const f of ['reports/gate-qa.json', 'reports/gate-security.json', 'reports/gate-security-dast.json']) expect(req).toContain(f);
    expect(functionBody('boolean gatePassed(String text, String commit)')).toContain('g.pass == true && String.valueOf(g.commit) == commit');
    expect(build).toMatch(/buildRc == 1\)\s*\{\s*error\(/);
    expect(build).toMatch(/buildRc == 3\)\s*\{\s*error\(/);
    expect(build).toMatch(/smokeRc != 0\)\s*\{\s*error\(/);
    expect(build).toContain('BUN_BIN="$LM_IMG_DIR/bin/bun" TMPDIR="$LM_IMG_DIR/tmp"');
    // 建置日誌不論成敗都寫入 Build_Record（Req 16.8）。
    expect(build).toMatch(/always\s*\{\s*script\s*\{\s*recordImageReports\('reports\/image-build-record-patch\.json', \[\s*imageBuildLog: 'reports\/image-build\.log'/);
    // 腳本用法與實作一致。
    const buildScript = readFileSync(resolve(root, 'ci/scripts/build-image.sh'), 'utf8');
    for (const s of ['--commit', '--repo', '--reports', 'BUN_BIN="${BUN_BIN:-bun}"', 'ref_file="${reports_dir}/image-ref.txt"', 'id_file="${reports_dir}/image-id.txt"']) expect(buildScript).toContain(s);
    const smokeScript = readFileSync(resolve(root, 'ci/scripts/image-smoke.sh'), 'utf8');
    for (const s of ['--image|--postgres-image|--runner-image|--reports|--label', 'image-smoke-summary.json']) expect(smokeScript).toContain(s);
    // 建置、掃描與 SBOM 階段沒有推送或簽章憑證（Req 15.2、16.8）。
    for (const b of [build, scan, sbom]) {
      expect(b).not.toMatch(/LM_REGISTRY_PUSH_CREDENTIALS|LM_COSIGN_/);
      expect(b).not.toMatch(/docker push|cosign /);
    }
    expect(build).not.toContain('withCredentials');
  });

  test('BUN_BIN 包裝：無網路的 Build_Image 容器、相同路徑掛載工作目錄與映像工作目錄', () => {
    expect(prepare).toContain("cat > \"$LM_IMG_DIR/bin/bun\" <<'EOF'");
    expect(prepare).toMatch(/\nEOF\n/);
    const [wrapper] = dockerRunsIn(prepare);
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--user "$(id -u):$(id -g)"', '--label "lm.ci.image=$LM_IMG_RUN"', '--entrypoint bun "$BUILD_IMAGE" "$@"', '-w "$PWD"']) {
      expect(wrapper).toContain(flag);
    }
    expect(wrapper).toContain('--mount "type=bind,src=$WORKSPACE,dst=$WORKSPACE"');
    expect(wrapper).toContain('--mount "type=bind,src=$LM_IMG_DIR,dst=$LM_IMG_DIR"');
    expect(prepare).toContain('chmod 0700 "$LM_IMG_DIR"');
    const cleanup = functionBody('void cleanupImageWork()');
    expect(cleanup).toContain('label=lm.ci.image=$LM_IMG_RUN');
    expect(cleanup).toContain('"$WORKSPACE_TMP"/lm-image-*) rm -rf -- "$LM_IMG_DIR" ;;');
  });

  test('映像工具以 LAN Registry 的 @sha256: digest 固定，且於拉取前驗證（Req 3.1、17.3）', () => {
    const tools = functionBody('List imageToolImages()');
    for (const name of ['LM_TRIVY_IMAGE', 'LM_SYFT_IMAGE', 'LM_CRANE_IMAGE', 'LM_COSIGN_IMAGE']) {
      expect(new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1]).toMatch(/^registry\.our-littlemoments\.com:8443\/[^@\s]+@sha256:[0-9a-f]{64}$/);
      expect(tools).toContain(`env.${name}`);
    }
    expect(tools).toContain('isPinnedImage(s)');
    expect(tools).toContain("!repo.startsWith(registry + '/')");
  });

  test('Image Scan：docker save → Trivy image（vuln + secret、15 分鐘）→ normalize → evaluate → 未通過即記錄關卡並停止（Req 17.1–17.3）', () => {
    inOrder(scan, [
      'docker save -o "$LM_IMG_DIR/scan/image.tar" "$LM_IMAGE_REF"', 'withCredentials([usernamePassword(',
      'image --input /scan/image.tar --scanners vuln,secret --list-all-pkgs --format json --output /out/trivy-image.json',
      'bun ci/policy/normalize.mjs --tool trivy --in "$LM_IMG_DIR/out/trivy-image.json" --out reports/security/trivy-image.json',
      'bun ci/policy/evaluate.mjs --reports reports/security/trivy-image.json', "recordImageGate('scan', '', false) != 0",
    ]);
    // Trivy 原始報告（可能含遮罩後的秘密所在行）在正規化後立即刪除，不保存至 Build_Record（Req 17.2）。
    expect(scan).toMatch(/--out reports\/security\/trivy-image\.json \|\| true\n\s*rm -f "\$LM_IMG_DIR\/out\/trivy-image\.json"\n/);
    expect(scan).toContain('credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS');
    expect(scan).toContain('timeout --kill-after=30 900 docker run');
    expect(scan).toContain("timeout(time: 17, unit: 'MINUTES')");
    expect(scan).toContain('--db-repository "$LM_TRIVY_DB_REPOSITORY"');
    expect(scan).toContain('--exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_IMG_TODAY"');
    expect(scan).toMatch(/trivyRc == 124 \|\| trivyRc == 137\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/trivyRc != 0\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/evalRc != 0 && evalRc != 1\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/recordImageGate\('scan', '', false\) != 0\)\s*\{\s*error\(/);
    // 映像掃描只讀取匯出的 tar，不掛載 docker.sock。
    expect(code).not.toMatch(/docker\.sock/);
  });

  test('SBOM：Syft（無網路、CycloneDX）→ ci/sbom-check.mjs → Build_Record → 「映像」推送前評估（Req 17.4、21.2、23.2）', () => {
    inOrder(sbom, [
      'scan docker-archive:/scan/image.tar --output cyclonedx-json=/out/sbom.cdx.json',
      'bun ci/sbom-check.mjs --in reports/sbom.cdx.json --image-id "$LM_IMAGE_ID" --out reports/sbom-summary.json',
      "[reports: [sbom: 'reports/sbom.cdx.json'", "env.LM_SBOM_OK = 'true'", "recordImageGate('prepush', '', true) != 0",
    ]);
    const [syft] = dockerRunsIn(sbom);
    expect(syft).toContain('--network none');
    expect(sbom).toMatch(/syftRc != 0\)\s*\{[\s\S]*?error\(/);
    expect(sbom).toMatch(/sbomRc != 0\)\s*\{\s*error\(/);
    expect(sbom).toMatch(/recordImageGate\('prepush', '', true\) != 0\)\s*\{\s*error\(/);
  });

  test('SBOM：Syft 的 /tmp tmpfs 為 mode=1777、不使用 --quiet；stderr 寫入 $LM_IMG_DIR/syft.log，失敗時印出最後 20 行後刪除（Design Components 第 28 節、Req 17.4、17.9）', () => {
    const script = /label: 'Syft SBOM', returnStatus: true, script: '''([\s\S]*?)'''/.exec(sbom)?.[1];
    expect(script).toBeDefined();
    const runs = dockerRunsIn(script);
    expect(runs.length).toBe(1);
    const [syft] = runs;
    expect(syft).toContain('"$LM_SYFT_IMAGE"');
    // tmpfs 加上 mode=1777，其餘隔離參數不變（第 28.1 節）。
    expect(syft).toContain('--tmpfs /tmp:rw,nosuid,nodev,size=4g,mode=1777 -e HOME=/tmp -e TMPDIR=/tmp');
    for (const flag of ['--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--network none', '--mount "type=bind,src=$LM_IMG_DIR/scan,dst=/scan,readonly"']) {
      expect(syft).toContain(flag);
    }
    // 不使用 --quiet；stderr 導向映像工作目錄下的 syft.log（不在 reports/ 下，第 28.2 節）。
    expect(script).not.toContain('--quiet');
    expect(syft).toMatch(/scan docker-archive:\/scan\/image\.tar --output cyclonedx-json=\/out\/sbom\.cdx\.json 2> "\$LM_IMG_DIR\/syft\.log" \|\| rc=\$\?$/);
    expect(script).not.toMatch(/reports\/[^\s"]*syft\.log/);
    expect(script).toMatch(/^\s*rm -f "\$LM_IMG_DIR\/out\/sbom\.cdx\.json" reports\/sbom\.cdx\.json reports\/sbom-summary\.json "\$LM_IMG_DIR\/syft\.log"$/m);
    // 失敗（含 rc=3）時印出最後 20 行，之後不論成敗都刪除 syft.log，最後以 rc 結束。
    inOrder(script, [
      '2> "$LM_IMG_DIR/syft.log" || rc=$?', 'rc=3', 'if [ "$rc" -ne 0 ]; then', "echo 'Syft 錯誤輸出（最後 20 行）：'",
      'tail -n 20 "$LM_IMG_DIR/syft.log"', 'rm -f "$LM_IMG_DIR/syft.log"\n', 'exit "$rc"',
    ]);
    expect(script).toMatch(/if \[ "\$rc" -ne 0 \]; then\n\s*echo 'Syft 錯誤輸出（最後 20 行）：'\n\s*tail -n 20 "\$LM_IMG_DIR\/syft\.log" 2>\/dev\/null \|\| true\n\s*fi\n\s*rm -f "\$LM_IMG_DIR\/syft\.log"\n\s*exit "\$rc"\n/);
    // 只修改 Syft：Trivy、crane 與 cosign（以及其他所有 docker run）的 tmpfs 不含 mode=1777（第 28.1 節）。
    const imageRuns = IMAGE_STAGES.flatMap((n) => dockerRunsIn(blocks[n]));
    for (const name of ['LM_TRIVY_IMAGE', 'LM_CRANE_IMAGE', 'LM_COSIGN_IMAGE']) {
      const found = imageRuns.filter((cmd) => cmd.includes(`"$${name}"`));
      expect(found.length).toBe(1);
      expect(found[0]).toMatch(/--tmpfs \/tmp:/);
      expect(found[0]).not.toContain('mode=1777');
    }
    const withMode = dockerRunsIn(code).filter((cmd) => cmd.includes('mode=1777'));
    expect(withMode).toEqual([syft]);
  });

  test('Image Push：拒絕覆寫既有標籤 → docker push → 三方 digest 比對 → image-digest.txt 封存並 fingerprint（Req 16.10、17.5、17.6、21.7）', () => {
    inOrder(push, [
      "env.LM_SBOM_OK != 'true'", 'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS',
      'DOCKER_CONFIG="$LM_IMG_DIR/docker-push"', 'mkdir -m 0700 "$DOCKER_CONFIG"', 'trap ', '--password-stdin "$registry"',
      'crane digest "$LM_IMAGE_REF" > "$out/existing-digest.txt"', 'exit 10', "MANIFEST_UNKNOWN|unexpected status code 404",
      'docker push --quiet "$LM_IMAGE_REF"', '{{range .RepoDigests}}', 'remote="$(crane digest "$LM_IMAGE_REF"',
      'by_digest="$(crane digest "$LM_IMAGE_REPO@$digest"', '[ "$remote" != "$digest" ] || [ "$by_digest" != "$digest" ]',
      "printf '%s\\\\n' \"$digest\" > reports/image-digest.txt",
      "image: [digest: digest, tags: [env.GIT_COMMIT_FULL]]", "archiveArtifacts(artifacts: 'reports/image-digest.txt', fingerprint: true)",
    ]);
    expect(push).toContain("trap 'docker logout \"$registry\" > /dev/null 2>&1 || true; rm -rf \"$DOCKER_CONFIG\"' EXIT");
    expect(push).toMatch(/pushRc == 10\)\s*\{\s*error\(/);
    expect(push).toMatch(/pushRc != 0\)\s*\{\s*error\(/);
    expect(push).toContain('digestFile != "${digest}\\n".toString()');
    // Registry 只以 Build_Image 所在 LAN Registry 的 repository 引用（標籤為完整 40 字元 SHA，Req 16.6）。
    expect(build).toContain('ref != "${env.LM_IMAGE_REPO}:${env.GIT_COMMIT_FULL}".toString()');
    // fingerprint ID 與 ci/digest-lookup.mjs 相同：MD5(`<digest>\n`)。
    expect(readFileSync(resolve(root, 'ci/digest-lookup.mjs'), 'utf8')).toContain("update(`${digest}\\n`, 'utf8')");
  });

  test('Image Sign：巢狀 withCredentials（推送帳號、cosign 私鑰檔、密碼）→ 以 digest 簽章（--tlog-upload=false）→ 驗證 → 完整「映像」關卡（Req 17.5、17.6）', () => {
    inOrder(sign, [
      "digest ==~ /^sha256:[0-9a-f]{64}$/", 'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS',
      'withCredentials([file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS', 'withCredentials([string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS',
      'ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"', 'cosign sign --yes --key /keys/cosign.key --tlog-upload=false "$ref"',
      'cosign public-key --key /keys/cosign.key --outfile /out/cosign.pub', 'unset COSIGN_PASSWORD',
      'cosign verify --key /out/cosign.pub --insecure-ignore-tlog=true --output json "$ref"',
      "String signatureText = readFile('reports/image-signature.json')", 'signatureCovers(signatureText, digest)', "image: [signature: 'verified']",
      "recordImageGate('final', '', true) != 0",
    ]);
    const [cosign] = dockerRunsIn(sign);
    expect(cosign).toContain('--mount "type=bind,src=$LM_COSIGN_KEY_FILE,dst=/keys/cosign.key,readonly"');
    expect(cosign).toContain('-e COSIGN_PASSWORD ');
    for (const s of [30, 31, 32]) expect(sign).toMatch(new RegExp(`signRc == ${s}\\)\\s*\\{\\s*error\\(`));
    expect(sign).toMatch(/!signatureCovers\([^\n]+\)\)\s*\{\s*error\(/);
    expect(sign).toMatch(/recordImageGate\('final', '', true\) != 0\)\s*\{\s*error\(/);
  });

  test('推送與簽章憑證只在 Image Push／Image Sign 與 staging-verified attestation 的 withCredentials 內；腳本 set +x、不經命令列傳遞秘密（Req 15.1、15.2、15.3）', () => {
    expect(/LM_REGISTRY_PUSH_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-registry-push');
    expect(/LM_COSIGN_KEY_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-key');
    expect(/LM_COSIGN_PASSPHRASE_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-passphrase');
    const uses = (re) => [...code.matchAll(re)].map((m) => m.index);
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    // 13.6 起 Staging Deploy 的 attestStaging()（cosign attest 需推送帳號、私鑰與密碼）是第三個使用處；
    // 13.7 起 Release_Tag 的 pushVersionTag()（crane tag 寫入版本標籤，不需私鑰）是第四個、也是唯一另外的使用處。
    const attest = functionBody('int attestStaging()');
    const versionTag = functionBody('int pushVersionTag()');
    // Components 第 22 節起 withCredentials 隨指令位於 Image Push／Image Sign 的階段函式內（Req 15.2）。
    const pushFn = functionBody('void runImagePushStage()');
    const signFn = functionBody('void runImageSignStage()');
    for (const i of uses(/credentialsId: env\.LM_REGISTRY_PUSH_CREDENTIALS/g)) {
      expect(inside(i, pushFn) || inside(i, signFn) || inside(i, attest) || inside(i, versionTag)).toBe(true);
    }
    expect(uses(/credentialsId: env\.LM_REGISTRY_PUSH_CREDENTIALS/g).length).toBe(4);
    expect(versionTag).not.toMatch(/LM_COSIGN_/);
    for (const re of [/credentialsId: env\.LM_COSIGN_KEY_CREDENTIALS/g, /credentialsId: env\.LM_COSIGN_PASSPHRASE_CREDENTIALS/g]) {
      const found = uses(re);
      expect(found.length).toBe(2);
      expect(inside(found[0], signFn)).toBe(true);
      expect(inside(found[1], attest)).toBe(true);
    }
    const secretScripts = tripleScripts.filter((s) => /LM_PUSH_PASSWORD|COSIGN_PASSWORD|LM_COSIGN_KEY_FILE/.test(s));
    expect(secretScripts.length).toBe(4);
    for (const s of secretScripts) {
      expect(s.trim().split('\n')[0].trim()).toBe('set +x');
      expect(s).toContain("printf '%s' \"$LM_PUSH_PASSWORD\" | docker login --username \"$LM_PUSH_USER\" --password-stdin");
      expect(s).not.toMatch(/echo[^\n]*\$(LM_PUSH_PASSWORD|COSIGN_PASSWORD|LM_COSIGN_PASSWORD)/);
      expect(s).not.toMatch(/-e (COSIGN_PASSWORD|LM_PUSH_PASSWORD)=|--password[ =]"?\$/);
    }
  });

  test('映像工具容器：非 root、唯讀根檔案系統、--cap-drop ALL、建置 label；可寫掛載只限映像工作目錄', () => {
    const runs = IMAGE_STAGES.flatMap((n) => dockerRunsIn(blocks[n]));
    // Trivy、Syft、crane（Image Push 的 shell 函式）、cosign（Image Sign 的 shell 函式）；Image Build 只呼叫 ci/scripts/。
    expect(runs.length).toBe(4);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.image=$LM_IMG_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).toMatch(/--network (none|bridge)\b/);
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) {
        if (!m[1].endsWith(',readonly')) expect(m[1]).toMatch(/^type=bind,src=\$LM_IMG_DIR\/(out|trivy-cache),dst=\/(out|cache)$/);
      }
    }
  });

  test('「映像」關卡：scan／prepush／final 三種條件、寫入 Build_Record，報告鍵通過白名單（Req 21.2、23.2、23.3、23.5）', () => {
    expect(gateFn).toContain("g.gate = '映像'");
    expect(gateFn).toContain("phase != 'scan' && facts.sbom != true");
    expect(gateFn).toContain("phase == 'final'");
    for (const s of ['signatureCovers(', 'recordImageFacts(', "rec.digest != digest || rec.commit != commit", "rec.sbom != 'reports/sbom.cdx.json'"]) expect(gateFn).toContain(s);
    expect(recordGate).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_IMAGE_GATE_FILE"');
    expect(recordGate).toMatch(/gate\.pass == true && !recordPass\)\s*\{\s*return 0/);
    expect(functionBody('void imageStageFailed(String stage)')).toMatch(/LM_IMAGE_GATE_ELIGIBLE == 'true' && env\.LM_IMAGE_GATE_DONE != 'true'[\s\S]*recordImageGate\(phase, imgStageError\(stage\), true\)/);
    // 所有寫入 Build_Record 的報告鍵與 image 區段通過 ci/record.mjs 的白名單；main_push 的 trivy／sbom 有值。
    const paths = {};
    for (const text of [recordGate, ...IMAGE_STAGES.map((n) => blocks[n])]) {
      for (const m of text.matchAll(/(\w+): '(reports\/[^']+)'/g)) paths[m[1]] = m[2];
    }
    for (const k of ['trivy', 'sbom', 'imageBuildLog', 'imageContent', 'imageSmokeSummary', 'imageScanEvaluation', 'imageDigest', 'imageSignature']) expect(paths[k]).toBeDefined();
    const digest = `sha256:${'d'.repeat(64)}`;
    let rec = mergeRecord(base(), { reports: paths });
    rec = mergeRecord(rec, { image: { digest, tags: ['a'.repeat(40)] } });
    rec = mergeRecord(rec, { image: { signature: 'verified' } });
    expect(validateRecord(rec).ok).toBe(true);
    expect(rec.image).toEqual({ digest, tags: ['a'.repeat(40)], signature: 'verified' });
  });
});

describe('main 專用的 Staging Deploy 階段（Req 14.1–14.3、14.8、15.9、17.7、17.8、18.1–18.5、18.7–18.9、23.2）', () => {
  const stg = stageCode(STAGE.STAGING);
  const deploy = functionBody('void deployStaging()');
  const restore = functionBody('void restoreStaging()');
  const deployCmd = functionBody('int stagingDeployCommand()');
  const host = functionBody('int stagingHost(String action, String outName)');
  const prelude = functionBody('String stagingSshPrelude()');
  const verify = functionBody('int verifyStagingSignature()');
  const attest = functionBody('int attestStaging()');
  const smoke = functionBody('int runStagingSmoke()');
  const record = functionBody('int recordStagingGate(String stageError)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const staging = readFileSync(resolve(root, 'ci/staging.mjs'), 'utf8');

  test('緊接 Image Sign 之後、只在 main_push 的 Trusted 規劃中執行，且在「映像」關卡通過後才部署（Req 1.3、2.8、23.2）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(14, 16)).toEqual([STAGE.IMAGE_SIGN, STAGE.STAGING]);
    expect(stg).toContain(`when {\n        expression { planned('${STAGE.STAGING}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }`);
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    expect(TRUSTED_ONLY_STAGES).toContain(STAGE.STAGING);
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.indexOf(STAGE.STAGING)).toBe(main.indexOf(STAGE.IMAGE_SIGN) + 1);
    for (const t of [{ event: 'tag', ref: 'v1.2.3' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature', manual: true }]) {
      expect(planStages(t).stages).not.toContain(STAGE.STAGING);
    }
    inOrder(stg, [
      'requireImageGatePassed()', "env.LM_STG_ELIGIBLE = 'true'", 'assertStagingConfig()', 'pullImages([env.LM_COSIGN_IMAGE])',
      'prepareStagingWork()', "lock(resource: 'lm-staging')", 'deployStaging()', 'restoreStaging()',
    ]);
    // 一般 lock 排隊等待，不以 skipIfLocked 略過（Req 18.9）。
    expect(stg).not.toContain('skipIfLocked');
    expect(stg).toMatch(/unsuccessful\s*\{\s*script\s*\{\s*stagingStageFailed\(\)/);
    expect(stg).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupStagingWork\(\)/);
    const req = functionBody('void requireImageGatePassed()');
    for (const s of ["reports/gate-image-final.json", "env.LM_IMAGE_GATE_DONE != 'true'", 'gatePassed(text, env.GIT_COMMIT_FULL', '/^sha256:[0-9a-f]{64}$/']) expect(req).toContain(s);
  });

  test('簽章驗證 → deploy → Smoke_Test → 判定 → 還原或 finalize → attestation →「Staging」關卡（Req 17.7、18.3–18.5）', () => {
    inOrder(deploy, [
      'verifyStagingSignature()', 'signatureCovers(sigText, digest)', "env.LM_STG_DEPLOY_CALLED = 'true'",
      "timeout(time: 75, unit: 'MINUTES')", 'stagingDeployCommand()', 'bun ci/staging.mjs classify --exit "$LM_STG_EXIT"',
      "c.outcome == 'refused'", 'runStagingSmoke()', 'bun ci/staging.mjs verdict', 'restoreStaging()',
      "env.LM_STG_VERIFIED = 'true'", "stagingHost('finalize', 'finalize.jsonl')", 'attestStaging()',
      'bun ci/staging.mjs check-attestation', "recordStagingGate('') != 0",
    ]);
    // 簽章未通過時不呼叫 Deploy_Host（Req 17.8）。
    expect(deploy.slice(0, deploy.indexOf('stagingDeployCommand()'))).toMatch(/if \(!sigOk\)\s*\{[\s\S]*?recordStagingGate\(''\)\s*error\(/);
    // 驗證未通過一律還原、記錄關卡並失敗，不寫 attestation。
    expect(deploy).toMatch(/if \(!verified\)\s*\{[\s\S]*?restoreStaging\(\)[\s\S]*?recordStagingGate\([\s\S]*?error\(/);
    expect(smoke).toContain("timeout(time: 10, unit: 'MINUTES')");
    expect(smoke).toContain('bun scripts/smoke.mjs > reports/staging/smoke.json');
    expect(smoke).toContain('credentialsId: env.LM_STAGING_SMOKE_CREDENTIALS, variable: \'CAMPING_SMOKE_PASSWORD_FILE\'');
    expect(smoke).toContain('"CAMPING_SMOKE_BASE_URL=${env.LM_STAGING_URL}"');
    // 還原整體 5 分鐘：status → rollback（需要時）→ status → health --wait → restore 判讀（Req 18.5、18.8）。
    inOrder(restore, [
      "timeout(time: 5, unit: 'MINUTES')", "stagingHost('status', 'status-before-restore.json')", 'bun ci/staging.mjs rollback-needed',
      "stagingHost('rollback', 'rollback.jsonl')", "stagingHost('status', 'status-after-restore.json')", 'bun ci/staging.mjs active',
      "stagingHost('health', 'restore-health.jsonl')", 'bun ci/staging.mjs restore',
    ]);
    expect(restore).toContain("code: 'restore_unconfirmed'");
    // CLI 子命令與參數存在於 ci/staging.mjs。
    for (const s of ["case 'classify'", "case 'rollback-needed'", "case 'active'", "case 'restore'", "case 'verdict'", "case 'check-attestation'", "case 'record'"]) expect(staging).toContain(s);
    for (const s of ["o['smoke-exit']", "o['out-predicate']", "o['rollback-exit']", "o['health-exit']", "o['out-patch']", "o['out-gate']", "o['stage-error']"]) expect(staging).toContain(s);
  });

  test('SSH：Staging 專用金鑰（不同於 Production）、known_hosts 憑證、StrictHostKeyChecking、forced command 子命令（Req 15.9）', () => {
    expect(/LM_SSH_STAGING_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-ssh-staging');
    const rollbackJf = readFileSync(resolve(root, 'ci/jenkins/pipelines/rollback.Jenkinsfile'), 'utf8');
    expect(/LM_SSH_PROD_CREDENTIALS = '([^']+)'/.exec(rollbackJf)?.[1]).toBe('lm-ssh-prod');
    // 13.7 起 Production Deploy 使用與 release/rollback 相同的 Production 金鑰；Staging 的函式從不引用它。
    expect(/LM_SSH_PROD_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-ssh-prod');
    expect(code.match(/lm-ssh-prod/g)?.length).toBe(1);
    for (const body of [deployCmd, host, stg, deploy, restore]) expect(body).not.toMatch(/LM_SSH_PROD_CREDENTIALS|lm-ssh-prod/);
    expect(/LM_KNOWN_HOSTS_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe(/LM_KNOWN_HOSTS_CREDENTIALS = '([^']+)'/.exec(rollbackJf)?.[1]);
    expect(prelude.split("'''")[1].trim().split('\n')[0].trim()).toBe('set +x');
    for (const flag of ['-F /dev/null', '-o BatchMode=yes', '-o IdentitiesOnly=yes', '-o IdentityAgent=none', '-o StrictHostKeyChecking=yes', '-o UserKnownHostsFile="$LM_KNOWN_HOSTS"', '-o GlobalKnownHostsFile=/dev/null']) {
      expect(prelude).toContain(flag);
    }
    for (const body of [deployCmd, host]) {
      expect(body).toContain('sshUserPrivateKey(credentialsId: env.LM_SSH_STAGING_CREDENTIALS');
      expect(body).toContain('file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS');
      expect(body).toContain('stagingSshPrelude()');
    }
    // forced command 綁定 `lm-deploy staging`：腳本只送出子命令，不含環境名稱。
    const cmds = [...(deployCmd + host).matchAll(/lm_ssh ([a-z-]+)/g)].map((m) => m[1]).sort();
    expect(cmds).toEqual(['deploy', 'finalize', 'health', 'rollback', 'status']);
    expect(deployCmd + host).not.toMatch(/lm_ssh [^>\n]*\b(prod|staging)\b/);
    expect(deployCmd).toContain('lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin > reports/staging/deploy.jsonl');
    expect(host).toContain('lm_ssh health "$LM_STG_COLOR" --wait');
    // app.env 只經 stdin（printf 內建指令）；DB 與 Setup_Token 憑證只在 deploy 的 withCredentials 內（Req 15.1、15.2）。
    for (const k of ['CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_SETUP_TOKEN']) {
      expect(deployCmd).toMatch(new RegExp(`printf '${k}=%s\\\\\\\\n' "\\$[A-Z_]+"`));
    }
    const uses = (re) => [...code.matchAll(re)].map((m) => m.index);
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    for (const re of [/credentialsId: env\.LM_STAGING_DB_CREDENTIALS/g, /credentialsId: env\.LM_STAGING_SETUP_TOKEN_CREDENTIALS/g]) {
      const found = uses(re);
      expect(found.length).toBe(1);
      expect(inside(found[0], deployCmd)).toBe(true);
    }
    expect(code).not.toMatch(/echo[^\n]*\$(LM_STG_DB_PASSWORD|LM_STG_SETUP_TOKEN|LM_REG_PASSWORD)/);
  });

  test('部署前以 Credential_Store 的公鑰驗證簽章；attestation 以 digest、--tlog-upload=false 推送後再驗證（Req 17.7、18.4）', () => {
    expect(/LM_COSIGN_PUBLIC_KEY_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-pub');
    inOrder(verify, [
      'credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS',
      'set +x', 'DOCKER_CONFIG="$LM_STG_DIR/docker-verify"', '--password-stdin "$registry"',
      '"$LM_COSIGN_IMAGE" verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json', '"$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" > reports/staging/signature.json',
    ]);
    inOrder(attest, [
      'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS',
      'string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS',
      'cp reports/staging/predicate.json "$LM_STG_DIR/in/predicate.json"', 'ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"',
      'cosign attest --yes --key /keys/cosign.key --tlog-upload=false --type "$LM_STAGING_PREDICATE_TYPE"', '--predicate /in/predicate.json "$ref"',
      'unset COSIGN_PASSWORD', 'cosign verify-attestation --key /keys/cosign.pub --insecure-ignore-tlog=true --type "$LM_STAGING_PREDICATE_TYPE"',
    ]);
    expect(/LM_STAGING_PREDICATE_TYPE = '([^']+)'/.exec(source)?.[1]).toBe('https://little-moments.lan/attestations/staging-verified/v1');
    // 所有 cosign 容器：非 root、唯讀根檔案系統、--cap-drop ALL、建置 label；掛載一律唯讀。
    const runs = [...dockerRunsIn(verify), ...dockerRunsIn(attest)];
    expect(runs.length).toBe(2);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.staging=$LM_STG_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) expect(m[1].endsWith(',readonly')).toBe(true);
    }
    expect(functionBody('void cleanupStagingWork()')).toContain('"$WORKSPACE_TMP"/lm-staging-*) rm -rf -- "$LM_STG_DIR" ;;');
  });

  test('「Staging」關卡與 Build_Record：ci/staging.mjs record → record.mjs merge → gate；失敗時 post 記錄未通過（Req 14.8、23.3、23.5）', () => {
    inOrder(record, [
      'bun ci/staging.mjs record "$@"', 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/staging-record-patch.json',
      'bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-staging.json', "env.LM_STG_GATE_DONE = 'true'",
    ]);
    expect(record).toContain('--signature "$LM_STG_SIGNATURE" --finalize "$LM_STG_FINALIZE" --attestation "$LM_STG_ATTESTATION"');
    expect(functionBody('void stagingStageFailed()')).toMatch(/LM_STG_ELIGIBLE == 'true' && env\.LM_STG_GATE_DONE != 'true'[\s\S]*recordStagingGate\(stgStageError\(\)\)/);
    // Staging 的 Health_Check 每 10 秒一次（Req 18.3）：Deploy_Host 的 lm-deploy 依環境決定間隔。
    const lmDeploy = readFileSync(resolve(root, 'deploy/bin/lm-deploy'), 'utf8');
    expect(lmDeploy).toMatch(/if \[\[ \$ENVN == staging \]\]; then HEALTH_INTERVAL=10; else HEALTH_INTERVAL=5; fi/);
  });
});

describe('Security Scan 報告鏈：normalize → evaluate（以 Jenkinsfile 的檔名與參數執行）', () => {
  const commit = 'c'.repeat(40);
  const secret = 'AKIAZZZZZZZZZZZZZZZZ-not-a-real-secret-value';
  const raw = {
    'gitleaks-dir': [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Match: secret, Secret: secret, Line: `const k = '${secret}'` }],
    'gitleaks-git': [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Commit: 'd'.repeat(40), Match: secret, Secret: secret }],
    osv: { results: [{ source: { path: '/src/bun.lock', type: 'lockfile' }, packages: [{ package: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm' }, groups: [], vulnerabilities: [] }] }] },
    'trivy-node-modules': { Trivy: { Version: '0.0.0' }, Results: [{ Target: 'node_modules', Packages: [{ Name: 'left-pad', Version: '1.3.0' }] }] },
    semgrep: { version: '1.0.0', errors: [], paths: { scanned: ['server/http.js'] }, results: [] },
  };
  const tools = { 'gitleaks-dir': 'gitleaks', 'gitleaks-git': 'gitleaks', osv: 'osv-scanner', 'trivy-node-modules': 'trivy', semgrep: 'semgrep' };

  async function runChain(names) {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { main: normalize } = await import('../ci/policy/normalize.mjs');
    const { main: evaluate } = await import('../ci/policy/evaluate.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'lm-sec-'));
    const quiet = { log: () => {}, error: () => {} };
    try {
      for (const name of Object.keys(tools)) {
        if (names.includes(name)) writeFileSync(join(dir, `${name}.raw.json`), JSON.stringify(raw[name]));
        normalize(['--tool', tools[name], '--in', join(dir, `${name}.raw.json`), '--out', join(dir, `${name}.json`)], quiet);
      }
      const out = join(dir, 'evaluation.json');
      const rc = evaluate([
        '--reports', ...Object.keys(tools).map((n) => join(dir, `${n}.json`)),
        '--exceptions', resolve(root, 'security/exceptions.json'), '--commit', commit, '--today', '2025-01-01', '--out', out,
      ], quiet);
      const files = Object.keys(tools).map((n) => join(dir, `${n}.json`)).concat(out);
      const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      return { rc, evaluation: JSON.parse(readFileSync(out, 'utf8')), text };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('偵測到秘密時不通過，且正規化與評估報告不含秘密原文（Req 6.4、6.7）', async () => {
    const { rc, evaluation, text } = await runChain(Object.keys(tools));
    expect(rc).toBe(1);
    expect(evaluation.pass).toBe(false);
    expect(evaluation.commit).toBe(commit);
    expect(evaluation.unresolved.map((f) => [f.scanner, f.id, f.location, f.line, f.reason])).toEqual([
      ['gitleaks', 'aws-access-token', 'server/config.js', 3, 'secret'],
      ['gitleaks', 'aws-access-token', 'server/config.js', 3, 'secret'],
    ]);
    expect(evaluation.unresolved[1].commit).toBe('d'.repeat(40));
    expect(text).not.toContain('AKIAZZZZ');
    expect(text).not.toContain('not-a-real-secret');
  });

  test('任一掃描報告缺失（例如 Git 歷史範圍無法決定）時視為未完成而不通過（Req 6.8）', async () => {
    raw['gitleaks-dir'] = [];
    try {
      const { rc, evaluation } = await runChain(['gitleaks-dir', 'osv', 'trivy-node-modules', 'semgrep']);
      expect(rc).toBe(1);
      expect(evaluation.pass).toBe(false);
      expect(evaluation.unresolved).toEqual([]);
      expect(evaluation.incomplete.map((i) => i.scanner)).toEqual(['gitleaks']);
      expect(evaluation.incomplete[0].file).toMatch(/gitleaks-git\.json$/);
    } finally {
      raw['gitleaks-dir'] = [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Match: secret, Secret: secret }];
    }
  });

  test('所有掃描完成且無 Critical/High 結果時通過', async () => {
    const clean = { ...raw };
    raw['gitleaks-dir'] = [];
    raw['gitleaks-git'] = [];
    try {
      const { rc, evaluation } = await runChain(Object.keys(tools));
      expect(rc).toBe(0);
      expect(evaluation.pass).toBe(true);
      expect(evaluation.scans.map((s) => s.complete)).toEqual([true, true, true, true, true]);
    } finally {
      Object.assign(raw, clean);
    }
  });
});

describe('verify-toolchain --record-patch（Req 3.3）', () => {
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 1, url: 'https://jenkins.invalid/job/1/',
    commit: 'a'.repeat(40), trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });

  test('實際版本寫入 toolchain 區段，報告路徑寫入 reports.toolchain，且通過 Build_Record 白名單', () => {
    const rec = toolchainRecord({ bun: '1.3.0', node: '22.20.0', chromium: '141.0.7390.37' }, { bun: '1.3.0', node: '22.19.0', chromium: null });
    const patch = recordPatch(rec, 'reports/toolchain.json');
    expect(patch).toEqual({ toolchain: { bun: '1.3.0', node: '22.19.0', chromium: null }, reports: { toolchain: 'reports/toolchain.json' } });
    const merged = mergeRecord(base(), patch);
    expect(validateRecord(merged).ok).toBe(true);
    expect(merged.toolchain).toEqual({ buildImageDigest: `sha256:${'b'.repeat(64)}`, bun: '1.3.0', node: '22.19.0', chromium: null });
  });

  test('沒有報告路徑時只輸出 toolchain 區段', () => {
    expect(recordPatch(toolchainRecord({}, {}), null)).toEqual({ toolchain: { bun: null, node: null, chromium: null } });
  });
});

describe('Release_Tag 專用階段：Resolve Digest → Version Tag → Approval → Production Deploy（Req 1.4、1.10、12.6、14.1–14.3、19、20、22.5、23）', () => {
  const RELEASE_STAGES = [STAGE.RESOLVE_DIGEST, STAGE.VERSION_TAG, STAGE.APPROVAL, STAGE.PRODUCTION];
  const blocks = Object.fromEntries(RELEASE_STAGES.map((n) => [n, stageCode(n)]));
  const resolveFn = functionBody('void resolveReleaseImage()');
  const registryFn = functionBody('int releaseRegistry(String action)');
  const versionFn = functionBody('void applyVersionTag()');
  const pushTag = functionBody('int pushVersionTag()');
  const prepare = functionBody('void prepareApproval()');
  const wait = functionBody('void waitForApproval()');
  const tagCheck = functionBody('boolean verifyTagUnchanged(String outName)');
  const recordApr = functionBody('int recordApproval(Map d)');
  const deploy = functionBody('void deployProduction()');
  const observe = functionBody('boolean observeProduction(String color)');
  const observeStepFn = functionBody('int observeStep(String type, int exitCode, String result, long ms, String phase)');
  const restore = functionBody('void restoreProduction()');
  const deployCmd = functionBody('int productionDeployCommand()');
  const host = functionBody('int prodHost(String action, String outName)');
  const smoke = functionBody('int runProductionSmoke(String outName)');
  const recordPrd = functionBody('int recordProductionGate(String stageError)');
  const lookupMain = functionBody('int fetchMainRecord()');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const production = readFileSync(resolve(root, 'ci/production.mjs'), 'utf8');
  const resolveDigest = readFileSync(resolve(root, 'ci/resolve-digest.mjs'), 'utf8');

  test('緊接 Staging Deploy 之後依序執行，且只在 release_tag 的 Trusted 規劃中執行（Req 1.4、2.8）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(15)).toEqual([STAGE.STAGING, ...RELEASE_STAGES]);
    for (const n of RELEASE_STAGES) {
      expect(blocks[n]).toContain(`when {\n        expression { planned('${n}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'release_tag' }`);
    }
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    for (const n of RELEASE_STAGES) expect(TRUSTED_ONLY_STAGES).toContain(n);
    const tag = planStages({ event: 'tag', ref: 'v1.2.3' }).stages;
    expect(tag.slice(tag.indexOf(STAGE.RESOLVE_DIGEST), tag.indexOf(STAGE.PRODUCTION) + 1)).toEqual(RELEASE_STAGES);
    for (const t of [{ event: 'push', ref: 'main' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature', manual: true }]) {
      for (const n of RELEASE_STAGES) expect(planStages(t).stages).not.toContain(n);
    }
    // 每個階段的前提都是前一個關卡已記錄且通過（Req 23.2）。
    inOrder(blocks[STAGE.RESOLVE_DIGEST], ['requireReleaseQualityGates()', "env.LM_REL_ELIGIBLE = 'true'", 'assertReleaseConfig()', 'pullImages([env.LM_CRANE_IMAGE, env.LM_COSIGN_IMAGE])', 'prepareReleaseWork()', 'resolveReleaseImage()']);
    inOrder(blocks[STAGE.VERSION_TAG], ['requireReleaseGatesPassed()', 'applyVersionTag()', "env.LM_REL_VERSION_TAG = 'true'"]);
    inOrder(blocks[STAGE.APPROVAL], ['requireReleaseGatesPassed()', "env.LM_REL_VERSION_TAG != 'true'", "env.LM_APR_ELIGIBLE = 'true'", 'assertProductionConfig()', 'prepareApproval()', 'waitForApproval()']);
    inOrder(blocks[STAGE.PRODUCTION], ['requireApprovalPassed()', "env.LM_PRD_ELIGIBLE = 'true'", 'assertProductionConfig()', 'pullImages([env.LM_COSIGN_IMAGE])', "lock(resource: 'lm-prod', skipIfLocked: true)", 'deployProduction()', 'restoreProduction()']);
    for (const [n, fn] of [[STAGE.RESOLVE_DIGEST, 'releaseStageFailed()'], [STAGE.APPROVAL, 'approvalStageFailed()'], [STAGE.PRODUCTION, 'productionStageFailed()']]) {
      expect(blocks[n]).toMatch(new RegExp(`unsuccessful\\s*\\{\\s*script\\s*\\{\\s*${fn.replace(/[()]/g, '\\$&')}`));
    }
    for (const n of RELEASE_STAGES) expect(blocks[n]).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupReleaseWork\(\)/);
    for (const [f, s] of [['void requireReleaseGatesPassed()', 'reports/gate-staging-release.json'], ['void requireApprovalPassed()', 'reports/gate-approval.json'], ['void requireReleaseQualityGates()', 'reports/gate-security-dast.json']]) {
      expect(functionBody(f)).toContain(s);
      expect(functionBody(f)).toContain('gatePassed(text, env.GIT_COMMIT_FULL');
    }
  });

  test('Resolve Digest：完整 SHA 標籤 → 查無即於摘要顯示並失敗（不進入核准）→「映像」→「Staging」（Req 1.10、19.5）', () => {
    inOrder(resolveFn, [
      "releaseRegistry('lookup')", 'bun ci/resolve-digest.mjs step lookup --commit "$GIT_COMMIT_FULL"', 'if (rc == 1)',
      'appendSummary("${why}', "image: [digest: '不適用']", 'error("${why}，不進入核准',
      "archiveArtifacts(artifacts: 'reports/image-digest.txt', fingerprint: true)",
      "releaseRegistry('verify')", 'fetchMainRecord()', 'bun ci/resolve-digest.mjs step image', "recordReleaseGate('reports/gate-image-release.json')",
      "releaseRegistry('attestation')", 'bun ci/resolve-digest.mjs step staging', "recordReleaseGate('reports/gate-staging-release.json')",
      "env.LM_REL_GATES_OK = 'true'",
    ]);
    expect(resolveFn).toMatch(/if \(rc != 0\)\s*\{\s*appendSummary\([^\n]*Staging/);
    // 查得的 digest 寫入 Build_Record 與 image-digest.txt（內容恰為 `<digest>\n`），與 main 建置相同的 fingerprint。
    expect(resolveFn).toContain('writeFile(file: \'reports/image-digest.txt\', text: "${digest}\\n".toString())');
    // crane／cosign：唯讀拉取帳號 + Credential_Store 公鑰，以 digest（不是標籤）驗證。
    inOrder(registryFn, [
      'credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS', 'set +x',
      'DOCKER_CONFIG="$LM_REL_DIR/docker-pull"', '--password-stdin "$registry"',
      'digest "$LM_IMAGE_REPO:$GIT_COMMIT_FULL"', 'verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json "$ref"',
      'verify-attestation --key /keys/cosign.pub --insecure-ignore-tlog=true', 'digest "$LM_IMAGE_REPO:$TAG_NAME"', 'config "$LM_IMAGE_REPO@$LM_REL_CONFIG_DIGEST"',
    ]);
    expect(registryFn).toContain('ref="$LM_IMAGE_REPO@${LM_IMAGE_DIGEST:-}"');
    const runs = [...dockerRunsIn(registryFn), ...dockerRunsIn(pushTag)];
    expect(runs.length).toBe(2);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.release=$LM_REL_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) expect(m[1].endsWith(',readonly')).toBe(true);
    }
    // main Build_Record：唯讀 Jenkins API token 只經 0600 檔交給 Build_Image 容器，結束時刪除。
    expect(/LM_JENKINS_API_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-jenkins-api-readonly');
    const lookupJf = readFileSync(resolve(root, 'ci/jenkins/pipelines/digest-lookup.Jenkinsfile'), 'utf8');
    expect(/LM_JENKINS_API_CREDENTIALS = '([^']+)'/.exec(lookupJf)?.[1]).toBe('lm-jenkins-api-readonly');
    inOrder(lookupMain, [
      'credentialsId: env.LM_JENKINS_API_CREDENTIALS', 'set +x', 'umask 077', 'mkdir -m 0700 "$LM_REL_TOKEN_DIR"',
      'LM_JENKINS_API_TOKEN_FILE="$LM_REL_TOKEN_DIR/token"', '--main-record-out reports/release/main-build-record.json', 'finally', 'rm -rf -- "$LM_REL_TOKEN_DIR"',
    ]);
    expect(lookupMain).not.toMatch(/LM_JENKINS_API_TOKEN=/);
    // step 子命令存在於 ci/resolve-digest.mjs。
    for (const s of ['lookup', 'image', 'staging', 'version-tag', 'version-tag-verify']) expect(resolveDigest).toContain(`'${s}'`);
    for (const s of ["case 'lookup'", "case 'image'", "case 'staging'", "case 'version-tag'", "case 'version-tag-verify'"]) expect(resolveDigest).toContain(s);
  });

  test('Version Tag：不覆寫既有標籤；推送帳號只在 pushVersionTag 內（Req 16.6、16.10）', () => {
    inOrder(versionFn, [
      "releaseRegistry('tag-get')", 'bun ci/resolve-digest.mjs step version-tag --digest "$LM_IMAGE_DIGEST"', 'if (rc == 4)',
      "d.decision == 'create'", 'pushVersionTag()', 'bun ci/resolve-digest.mjs step version-tag-verify', "d.decision != 'noop'",
      'image: [tags: [env.GIT_COMMIT_FULL, tag]]',
    ]);
    expect(versionFn).toMatch(/if \(rc == 4\)\s*\{\s*appendSummary\([\s\S]*?error\(/);
    inOrder(pushTag, [
      'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS', 'set +x', 'DOCKER_CONFIG="$LM_REL_DIR/docker-push"', 'trap ',
      'crane tag "$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" "$TAG_NAME"', 'crane digest "$LM_IMAGE_REPO:$TAG_NAME"',
    ]);
  });

  test('Approval：核准畫面內容、24 小時迴圈、破壞性遷移另行核准、git ls-remote、記錄「正式核准」（Req 12.6、19.2–19.8）', () => {
    inOrder(prepare, [
      'bun ci/rollback.mjs approvers', 'env.LM_APR_SUBMITTERS = ids.join', "prodHost('status', 'status-approval.json')",
      "releaseRegistry('config')", 'bun ci/production.mjs deployed-commit', 'git ls-tree --name-only "${LM_PRD_BASE_COMMIT:-}" -- migrations/',
      'bun ci/production.mjs destructive --migrations migrations --deployed "$deployed"', 'lmDestructivePending = pending',
      'archiveArtifacts(', 'bun ci/production.mjs approval-message --tag "$TAG_NAME" --commit "$GIT_COMMIT_FULL" --digest "$LM_IMAGE_DIGEST"',
    ]);
    // 核准等待期間對 Production 只執行 status（唯讀）。
    expect(prepare.match(/prodHost\('([a-z-]+)'/g)).toEqual(["prodHost('status'"]);
    expect(wait.match(/prodHost\(/g)).toBeNull();
    inOrder(wait, [
      "timeout(time: 24, unit: 'HOURS')", 'releaseApprovalLoop(message)', 'destructiveApprovalLoop(m)', 'lmDestructiveApprovals <<',
      "verifyTagUnchanged('tag-remote-approval.txt')", 'recordApproval(decision)', "env.LM_APPROVED = 'true'",
    ]);
    expect(wait).toContain("decision.decision = 'tag_changed'");
    expect(wait).toContain('throw rethrow');
    expect(wait).toContain("currentBuild.result = 'ABORTED'");
    inOrder(tagCheck, ['gitUsernamePassword(credentialsId: env.LM_GIT_CREDENTIALS)', 'git ls-remote origin "refs/tags/$TAG_NAME" "refs/tags/$TAG_NAME^{}"', 'bun ci/production.mjs tag-remote']);
    inOrder(recordApr, [
      "writeFile(file: 'reports/production/approval-input.json'", 'bun ci/production.mjs approval-record', 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/production/approval-record-patch.json',
      'bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-approval.json', "env.LM_APR_GATE_DONE = 'true'",
    ]);
    for (const s of ['attempts: lmApprovalAttempts', 'destructive: lmDestructiveApprovals', 'pendingDestructive: lmDestructivePending']) expect(recordApr).toContain(s);
    // 送出者與拒絕者的帳號只經環境變數交給 ci/approval.mjs，且先以格式驗證。
    expect(functionBody('void recordAttempt(String who, String action, String migration)')).toContain('lmApprovalAttempts << [id: id, at: at, action: action, migration: migration]');
    expect(functionBody('String inputRejecter(Object err)')).toContain('org.jenkinsci.plugins.workflow.support.steps.input.Rejection');
  });

  test('Production Deploy：Tag 與目前版本再確認 → 簽章 → deploy → 觀察期 → 回滾或 finalize →「上線後」（Req 17.8、20.1–20.7、20.12）', () => {
    expect(blocks[STAGE.PRODUCTION]).toMatch(/if \(!acquired\)\s*\{\s*recordProductionGate\([^\n]*\)\s*error\('已有部署進行中/);
    inOrder(deploy, [
      "verifyTagUnchanged('tag-remote-deploy.txt')", "prodHost('status', 'status-locked.json')", "env.LM_PRD_DESTRUCTIVE_KNOWN == 'true' && base != (env.LM_PRD_BASE_DIGEST",
      "releaseRegistry('verify-prod')", 'signatureCovers(sigText, digest)', "env.LM_PRD_DEPLOY_CALLED = 'true'",
      "timeout(time: 75, unit: 'MINUTES')", 'productionDeployCommand()', 'bun ci/production.mjs classify --exit "$LM_PRD_EXIT"',
      "c.outcome == 'refused'", 'restoreProduction()', "timeout(time: 15, unit: 'MINUTES')", 'observeProduction(color)',
      "prdStep('「上線後」關卡未通過；已自動回滾", "env.LM_PRD_OBSERVED = 'true'", "prodHost('finalize', 'finalize.jsonl')", "recordProductionGate('') != 0",
    ]);
    // 簽章未通過時不呼叫 Deploy_Host 的 deploy（Req 17.8）。
    expect(deploy.slice(0, deploy.indexOf('productionDeployCommand()'))).toMatch(/if \(!sigOk\)\s*\{[\s\S]*?recordProductionGate\([\s\S]*?error\(/);
    // 觀察期：每 10 秒一次 Health_Check（共 60 次）、切換後與結束前各一次 Smoke_Test、10 分鐘（Req 20.5）。
    inOrder(observe, [
      'for (int i = 0; i < 60; i++)', 'long wait = t0 + i * 10000L - System.currentTimeMillis()', "prodHost('health-once', 'health-last.jsonl')",
      "observeStep('health'", 'if (i == 0 || i == 54)', 'runProductionSmoke(', "observeStep('smoke'", 't0 + 600000L', 'bun ci/production.mjs summary',
    ]);
    expect(observe.match(/return false/g)?.length).toBe(2);
    expect(observeStepFn).toContain('bun ci/production.mjs observe "$@"');
    expect(observeStepFn).toContain('--t "$(( LM_PRD_OBS_MS / 1000 ))"');
    // 回滾：status → rollback（自動，不執行 Migration_Runner）→ status → 舊槽位 health --wait → 判讀（Req 20.6、20.9、20.11）。
    inOrder(restore, [
      "timeout(time: 5, unit: 'MINUTES')", "prodHost('status', 'status-before-restore.json')", 'bun ci/production.mjs rollback-needed',
      "prodHost('rollback', 'rollback.jsonl')", "prodHost('status', 'status-after-restore.json')", 'bun ci/production.mjs active',
      "prodHost('health-wait', 'restore-health.jsonl')", 'bun ci/production.mjs restore',
    ]);
    expect(restore).toContain("code: 'restore_unconfirmed'");
    expect(smoke).toContain("timeout(time: 90, unit: 'SECONDS')");
    expect(smoke).toContain("credentialsId: env.LM_PROD_SMOKE_CREDENTIALS, variable: 'CAMPING_SMOKE_PASSWORD_FILE'");
    expect(smoke).toContain('"CAMPING_SMOKE_BASE_URL=${env.LM_PROD_URL}"');
    expect(smoke).toContain('bun scripts/smoke.mjs > "$LM_PRD_SMOKE_OUT"');
    inOrder(recordPrd, [
      'bun ci/production.mjs record "$@"', 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/production-record-patch.json',
      'bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-post-deploy.json', "env.LM_PRD_GATE_DONE = 'true'",
      "fileExists('reports/production/rollback-summary.txt')", 'appendSummary(',
    ]);
    expect(recordPrd).toContain('--signature "$LM_PRD_SIGNATURE" --finalize "$LM_PRD_FINALIZE"');
    expect(functionBody('void productionStageFailed()')).toMatch(/LM_PRD_ELIGIBLE == 'true' && env\.LM_PRD_GATE_DONE != 'true'[\s\S]*recordProductionGate\(prdStageError\(\)\)/);
    // 觀察期通過前的未預期錯誤或中止一律回滾。
    expect(blocks[STAGE.PRODUCTION]).toMatch(/catch \(err\)\s*\{[\s\S]*?LM_PRD_DEPLOY_CALLED == 'true' && env\.LM_PRD_OBSERVED != 'true' && env\.LM_PRD_RESTORE_DONE != 'true'[\s\S]*?restoreProduction\(\)[\s\S]*?throw err/);
  });

  test('Production SSH 與憑證：lm-ssh-prod、known_hosts、forced command 子命令；DB 與 Setup_Token 只經 stdin（Req 15.1、15.2、15.9）', () => {
    for (const [name, id] of [['LM_PROD_DB_CREDENTIALS', 'lm-prod-db'], ['LM_PROD_SETUP_TOKEN_CREDENTIALS', 'lm-prod-setup-token'], ['LM_PROD_SMOKE_CREDENTIALS', 'lm-prod-smoke']]) {
      expect(new RegExp(`${name} = '([^']+)'`).exec(source)?.[1]).toBe(id);
    }
    for (const body of [deployCmd, host]) {
      expect(body).toContain('sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS');
      expect(body).toContain('file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS');
      expect(body).toContain('productionSshPrelude()');
      expect(body).not.toContain('LM_SSH_STAGING_CREDENTIALS');
    }
    expect(functionBody('String productionSshPrelude()')).toContain('return stagingSshPrelude()');
    const cmds = [...(deployCmd + host).matchAll(/lm_ssh ([a-z-]+)/g)].map((m) => m[1]).sort();
    expect(cmds).toEqual(['deploy', 'finalize', 'health', 'health', 'rollback', 'status']);
    expect(deployCmd + host).not.toMatch(/lm_ssh [^>\n]*\b(prod|staging)\b/);
    expect(host).toContain(`'health-once': 'lm_ssh health "$LM_PRD_COLOR" > "$LM_PRD_OUT"\\n'`);
    expect(host).toContain(`'health-wait': 'lm_ssh health "$LM_PRD_COLOR" --wait > "$LM_PRD_OUT"\\n'`);
    expect(deployCmd).toContain('lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin > reports/production/deploy.jsonl');
    for (const k of ['CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_SETUP_TOKEN']) {
      expect(deployCmd).toMatch(new RegExp(`printf '${k}=%s\\\\\\\\n' "\\$[A-Z_]+"`));
    }
    const uses = (re) => [...code.matchAll(re)].map((m) => m.index);
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    for (const re of [/credentialsId: env\.LM_PROD_DB_CREDENTIALS/g, /credentialsId: env\.LM_PROD_SETUP_TOKEN_CREDENTIALS/g]) {
      const found = uses(re);
      expect(found.length).toBe(1);
      expect(inside(found[0], deployCmd)).toBe(true);
    }
    for (const i of uses(/credentialsId: env\.LM_SSH_PROD_CREDENTIALS/g)) expect(inside(i, deployCmd) || inside(i, host)).toBe(true);
    expect(code).not.toMatch(/echo[^\n]*\$(LM_PRD_DB_PASSWORD|LM_PRD_SETUP_TOKEN|LM_JENKINS_API_TOKEN_SRC)/);
    // lm-deploy 的單次 health 不取鎖，輸出 healthy／durationMs（觀察期由 Pipeline 每 10 秒呼叫）；prod 啟動健康每 5 秒（Req 20.3）。
    const lmDeploy = readFileSync(resolve(root, 'deploy/bin/lm-deploy'), 'utf8');
    expect(lmDeploy).toContain('\\"healthy\\":true,\\"at\\":$(jstr "$at"),\\"durationMs\\":$H_MS}');
    expect(lmDeploy).toMatch(/health\)\n\s+local color="" wait=0[\s\S]*?load_state\n\s+load_env_config/);
  });

  test('收據 AI（Components 第 25.3 節；Req 15.6–15.8）：設定檢查、Production 的金鑰綁定範圍與建置摘要', () => {
    const value = (name) => new RegExp(`^    ${name} = '([^']*)'$`, 'm').exec(code)?.[1];
    expect(value('LM_STAGING_RECEIPT_AI')).toBe('disabled');
    expect(['enabled', 'disabled']).toContain(value('LM_PROD_RECEIPT_AI'));
    expect(value('LM_PROD_OPENAI_CREDENTIALS')).toBe('lm-prod-openai-api-key');
    // 設定檢查在連線 Deploy_Host 之前（Staging Deploy 與 Approval／Production Deploy 都先呼叫）。
    const stgCfg = functionBody('void assertStagingConfig()');
    expect(stgCfg).toMatch(/if \(env\.LM_STAGING_RECEIPT_AI != 'disabled'\) \{\s*error\('LM_STAGING_RECEIPT_AI 只能是 disabled（Staging 不啟用收據 AI）'\)/);
    const prdCfg = functionBody('void assertProductionConfig()');
    expect(prdCfg).toMatch(/if \(env\.LM_PROD_RECEIPT_AI != 'enabled' && env\.LM_PROD_RECEIPT_AI != 'disabled'\) \{\s*error\(/);
    expect(prdCfg).toMatch(/if \(env\.LM_PROD_RECEIPT_AI == 'enabled' && env\.LM_PROD_OPENAI_CREDENTIALS != 'lm-prod-openai-api-key'\) \{\s*error\(/);
    // 啟用時金鑰檔只綁定在 deploy 那一次 sh；停用時執行同一段腳本、不綁定。
    expect(deployCmd).toMatch(/if \(env\.LM_PROD_RECEIPT_AI == 'enabled'\) \{[^{}]*withCredentials\(\[file\(credentialsId: env\.LM_PROD_OPENAI_CREDENTIALS, variable: 'LM_PRD_OPENAI_KEY_FILE'\)\]\) \{\s*rc = sh\(label: 'lm-deploy prod deploy', returnStatus: true, script: script\)\s*\}\s*\} else \{\s*rc = sh\(label: 'lm-deploy prod deploy', returnStatus: true, script: script\)\s*\}/);
    expect(deployCmd.match(/String script = productionSshPrelude\(\) \+ '''/g)?.length).toBe(1);
    // 啟用時金鑰檔必須非空，否則不連線（exit 2）；stdin 第一行是開關，金鑰在最後一行。
    inOrder(deployCmd, [
      'rm -f reports/production/deploy.jsonl', 'case "${LM_PROD_RECEIPT_AI:-}" in', 'if [ ! -s "${LM_PRD_OPENAI_KEY_FILE:-}" ]; then', 'exit 2',
      "printf 'LM_RECEIPT_AI=%s\\\\n' \"$LM_PROD_RECEIPT_AI\"", "printf 'CAMPING_DATABASE_NAME=%s\\\\n'", "printf 'CAMPING_SETUP_TOKEN=%s\\\\n'",
      'if [ "$LM_PROD_RECEIPT_AI" = enabled ]; then', 'IFS= read -r k < "$LM_PRD_OPENAI_KEY_FILE" || [ -n "$k" ]',
      "printf 'LM_OPENAI_API_KEY=%s\\\\n' \"$k\"", '} | lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin > reports/production/deploy.jsonl',
    ]);
    // 建置摘要只有列舉值（不含金鑰、長度或前綴），在 classify 之後、拒絕判斷之前。
    inOrder(deploy, [
      'bun ci/production.mjs classify --exit "$LM_PRD_EXIT"', "Map c = readJsonFile('reports/production/deploy-verdict.json')",
      "String receiptAi = (c.receiptAi == 'enabled' || c.receiptAi == 'disabled') ? c.receiptAi : '未執行'",
      'appendSummary("收據 AI（Production）：${receiptAi}".toString())', "c.outcome == 'refused'",
    ]);
  });

  test('Jenkinsfile 呼叫的 ci/production.mjs 子命令皆存在', () => {
    const used = [...new Set([...code.matchAll(/bun ci\/production\.mjs ([a-z-]+)/g)].map((m) => m[1]))].sort();
    expect(used).toEqual(['active', 'approval-message', 'approval-record', 'classify', 'deployed-commit', 'destructive', 'observe', 'record', 'restore', 'rollback-needed', 'summary', 'tag-remote']);
    for (const s of used) expect(production).toContain(`case '${s}'`);
  });
});

describe('收尾 post { always } 與 post { cleanup }（13.8；Req 2.6、15.4、21.2、21.6、21.9、21.11、22.2–22.4、22.7、22.8、23.1）', () => {
  // 管線層級的 post（兩個空白縮排）位於 stages 之後、輔助函式之前；Components 第 22.1 節起 always／cleanup
  // 只呼叫 pipelinePostAlways()／pipelinePostCleanup()，收尾步驟在這兩個頂層函式內。
  const postStart = code.indexOf('\n  post {\n    always {');
  const helpers = code.indexOf('\nvoid enterStage(String name)');
  const post = code.slice(postStart, code.indexOf('\n}\n', postStart) + 3);
  const always = functionBody('void pipelinePostAlways()');
  const cleanup = functionBody('void pipelinePostCleanup()');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { let prev = -1; for (const s of list) { const i = text.indexOf(s, prev + 1); expect(i).toBeGreaterThan(prev); prev = i; } };
  const archive = functionBody('void archiveScrubbedReports(Map outcome)');
  const scrubRun = functionBody('int scrubReports()');
  const specs = functionBody('List scrubCredentialSpecs()');
  const stageSecret = functionBody('void stageScrubSecret(Map s)');
  const keep = functionBody('void keepProductionBuildLog()');
  const resources = functionBody('void cleanupBuildResources()');
  const notify = functionBody('void notifyFinal()');
  const outcome = functionBody('Map finalOutcome(String result, String currentStage, String postFailure)');

  test('管線層級 post 位於 stages 之後；always 依序 finalize → 遮罩封存 → keepLog → 清除資源 → 通知；cleanup 最後 cleanWs()', () => {
    expect(postStart).toBeGreaterThan(code.indexOf("stage('Production Deploy')"));
    expect(helpers).toBeGreaterThan(postStart);
    expect(post).toMatch(/^\n  post \{\n    always \{\n      script \{ pipelinePostAlways\(\) \}\n    \}\n    cleanup \{\n      script \{ pipelinePostCleanup\(\) \}\n    \}\n  \}\n\}\n$/);
    expect(code.indexOf('\nvoid pipelinePostAlways()')).toBeLessThan(helpers);
    inOrder(always, [
      "postStep('Post Finalize') { finalizeBuildRecord(outcome) }",
      "postStep('Post Archive') { archiveScrubbedReports(outcome) }",
      "postStep('Post Keep Log') { keepProductionBuildLog() }",
      "postStep('Post Cleanup') { cleanupBuildResources() }",
      'notifyFinal()',
    ]);
    // 結果在任何收尾步驟之前取得，第一個失敗階段取自 enterStage 記錄的 LM_CURRENT_STAGE。
    expect(at(always, 'env.LM_POST_RESULT_BEFORE = currentBuild.currentResult')).toBeLessThan(at(always, 'postStep('));
    expect(always).toContain("finalOutcome(currentBuild.currentResult, env.LM_CURRENT_STAGE ?: '', '')");
    inOrder(cleanup, ["postStep('Post Cleanup') { removePostWork() }", 'cleanWs(deleteDirs: true, disableDeferredWipeout: true)', 'dir(env.WORKSPACE_TMP) { deleteDir() }']);
    expect(always).not.toContain('cleanWs(');
  });

  test('每個收尾步驟以 catchError 隔離：失敗只讓結果變差、不略過後續步驟，並記錄第一個失敗的收尾步驟', () => {
    const step = functionBody('void postStep(String step, Closure body)');
    expect(step).toContain("catchError(buildResult: 'FAILURE'");
    // catchError 的 buildResult 只會讓結果變差（不覆蓋 FAILURE／ABORTED）；不設定 stageResult（post 不在任何 stage 內）。
    expect(step).not.toContain('stageResult');
    expect(step).toMatch(/catch \(err\) \{\s*if \(!env\.LM_POST_FAILED_STEP\) \{ env\.LM_POST_FAILED_STEP = step \}\s*throw err/);
    for (const s of ['Post Finalize', 'Post Archive', 'Post Keep Log', 'Post Cleanup']) expect(always).toContain(`postStep('${s}')`);
    expect(cleanup.match(/catchError\(buildResult: 'FAILURE'/g)?.length).toBe(2);
  });

  test('Build_Record finalize：結果、結束時間與第一個失敗階段（Req 21.2、21.11）', () => {
    const fin = functionBody('void finalizeBuildRecord(Map outcome)');
    inOrder(fin, ['fileExists(env.LM_RECORD)', 'LM_POST_STATUS=${outcome.record}', 'LM_POST_FAILED_STAGE=${outcome.failedStage', 'inBuildImage {', 'bun ci/record.mjs finalize "$@"']);
    expect(fin).toContain('set -- --record "$LM_RECORD" --status "$LM_POST_STATUS"');
    expect(fin).toContain('--first-failed-stage "${LM_POST_FAILED_STAGE:-}"');
    // 結果對應：SUCCESS／FAILURE／ABORTED（ci/record.mjs 的 RESULT_STATUSES）與通知的最終狀態。
    expect(outcome).toContain("r == 'SUCCESS' ? 'SUCCESS' : ((r == 'ABORTED' || r == 'NOT_BUILT') ? 'ABORTED' : 'FAILURE')");
    for (const s of ["'success'", "'unstable'", "'aborted'", "'failure'"]) expect(outcome).toContain(s);
    expect(outcome).toMatch(/if \(record != 'SUCCESS'\) \{\s*stage = postFailure \?: \(currentStage \?: 'Init'\)/);
    // record.mjs 的 finalize 寫入含時區的結束時間。
    const record = readFileSync(resolve(root, 'ci/record.mjs'), 'utf8');
    expect(record).toContain("status: o.status, firstFailedStage: o['first-failed-stage'], endedAt: new Date().toISOString()");
  });

  test('封存前遮罩：重新取得秘密 → ci/scrub.mjs → 只封存遮罩後副本；秘密集合不完整或無法完成時不封存（Req 15.4、21.9、23.1）', () => {
    inOrder(archive, [
      "env.LM_SCRUB_INCOMPLETE == 'true'",
      'stageScrubSecrets()',
      'int rc = scrubReports()',
      'markRecordArchiveFailure()',
      'if (rc != 0 && rc != 1)',
      'dir("${env.WORKSPACE_TMP}/lm-post/archive")',
      'archiveArtifacts(',
      "env.LM_POST_ARCHIVED = 'true'",
      'if (rc == 1)',
      'finally {',
      'removeScrubSecrets()',
    ]);
    // 任何 archiveArtifacts 都在 scrub 之後、且只在遮罩輸出目錄內。
    const scrubAt = at(archive, 'scrubReports()');
    for (const m of archive.matchAll(/archiveArtifacts\(/g)) expect(m.index).toBeGreaterThan(scrubAt);
    expect(archive).toContain("archiveArtifacts(artifacts: 'reports/**', excludes: 'reports/image-digest.txt, reports/build-record.json', allowEmptyArchive: true)");
    expect(archive).toContain("archiveArtifacts(artifacts: 'reports/build-record.json', fingerprint: true)");
    // 無法取得秘密、Build_Image 無法使用或 scrub 無法完成：寫入摘要並 error()，在 archiveArtifacts 之前。
    for (const s of ['if (!missing.isEmpty())', 'if (!env.BUILD_IMAGE_DIGEST)', 'if (rc != 0 && rc != 1)']) {
      const i = at(archive, s);
      expect(archive.indexOf('error(', i)).toBeLessThan(at(archive, 'archiveArtifacts('));
    }
    // scrub：secrets 只以目錄路徑傳遞；輸入為 reports/，輸出與處理報告在 $WORKSPACE_TMP；無法完成時刪除輸出。
    expect(scrubRun).toContain('bun ci/scrub.mjs --secrets-dir "$WORKSPACE_TMP/lm-scrub-secrets" --in reports --out "$out/reports"');
    expect(scrubRun).toContain('--report "$out/reports/archive-scrub.json"');
    expect(scrubRun).toMatch(/if \[ "\$rc" -ne 0 \] && \[ "\$rc" -ne 1 \]; then\s*rm -rf "\$out"/);
    expect(scrubRun).toContain("timeout(time: 10, unit: 'MINUTES')");
    // 遮罩後仍有檔案被扣留且原本成功：Build_Record 改記錄為失敗後重新遮罩，使封存的紀錄與最終結果一致。
    expect(functionBody('void markRecordArchiveFailure()')).toContain("[result: [status: 'FAILURE', firstFailedStage: 'Post Archive']]");
    // image-digest.txt 的 fingerprint 仍只在產生時封存（Image Push 與 Resolve Digest 各一次）。
    expect(code.match(/archiveArtifacts\(artifacts: 'reports\/image-digest\.txt', fingerprint: true\)/g)?.length).toBe(2);
  });

  test('遮罩用秘密：只取本建置進入過的階段用過的憑證，Untrusted 只有拉取帳號與 Git 憑證；值只寫入 0600 檔（Req 2.4、15.2）', () => {
    const entries = [...specs.matchAll(/\[id: env\.(LM_[A-Z_]+_CREDENTIALS), kind: '(password|secret|file|ssh)', trusted: (true|false), stages: \[([^\]]*)\]\]/g)];
    // 14 個固定項目 + 收據 AI 啟用時才列入的 OpenAI 金鑰（Components 第 25.3 節）。
    expect(entries.length).toBe(15);
    // OpenAI 金鑰：file、只在 Production Deploy，且只在 LM_PROD_RECEIPT_AI == 'enabled' 時加入清單。
    expect(entries.filter((m) => m[1] === 'LM_PROD_OPENAI_CREDENTIALS').map((m) => [m[2], m[3], m[4]])).toEqual([['file', 'true', "'Production Deploy'"]]);
    expect(specs).toMatch(/if \(env\.LM_PROD_RECEIPT_AI == 'enabled'\) \{\s*all << \[id: env\.LM_PROD_OPENAI_CREDENTIALS, kind: 'file', trusted: true, stages: \['Production Deploy'\]\]\s*\}/);
    expect(specs.slice(0, specs.indexOf('List out = []')).match(/LM_PROD_OPENAI_CREDENTIALS/g)?.length).toBe(1);
    expect(entries.filter((m) => m[3] === 'false').map((m) => m[1])).toEqual(['LM_REGISTRY_PULL_CREDENTIALS', 'LM_GIT_CREDENTIALS']);
    // 每個 trusted 憑證都以其使用階段限制；階段名稱屬於 ci/stages.mjs。
    const known = new Set(Object.values(STAGE));
    for (const m of entries.filter((e) => e[3] === 'true')) {
      const stages = [...m[4].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      expect(stages.length).toBeGreaterThan(0);
      for (const s of stages) expect(known.has(s)).toBe(true);
    }
    // 環境變數中的每個憑證 ID 常數都存在（known_hosts、cosign 公鑰與 keepLog 帳號除外：非秘密或於封存後才使用）。
    for (const m of entries) expect(source).toMatch(new RegExp(`\\n    ${m[1]} = '[a-z0-9-]+'`));
    expect(specs).toContain("env.LM_TRUSTED == 'true' && (env.JOB_NAME ?: '').startsWith('release/')");
    expect(specs).toContain("(env.LM_STAGES_ENTERED ?: '').tokenize('|')");
    expect(functionBody('void enterStage(String name)')).toContain('env.LM_STAGES_ENTERED');
    // 每種憑證各一個 withCredentials；變數只有 LM_SCRUB_VALUE／LM_SCRUB_FILE（與 LM_SCRUB_USER），ID 先驗證格式。
    expect(stageSecret.match(/withCredentials\(\[/g)?.length).toBe(4);
    for (const s of ["string(credentialsId: id, variable: 'LM_SCRUB_VALUE')", "passwordVariable: 'LM_SCRUB_VALUE'", "file(credentialsId: id, variable: 'LM_SCRUB_FILE')", "keyFileVariable: 'LM_SCRUB_FILE'"]) {
      expect(stageSecret).toContain(s);
    }
    expect(stageSecret).toContain('id ==~ /^[a-z0-9][a-z0-9-]{0,63}$/');
    expect(functionBody('void writeScrubValue()')).toContain(`printf '%s' "\${LM_SCRUB_VALUE:-}" > "$d/$LM_SCRUB_NAME"`);
    expect(functionBody('void writeScrubFile()')).toContain('cat -- "$LM_SCRUB_FILE" > "$d/$LM_SCRUB_NAME"');
    for (const fn of ['void writeScrubValue()', 'void writeScrubFile()']) {
      const body = functionBody(fn);
      inOrder(body, ['set +x', 'umask 077', 'mkdir -p -m 0700 "$d"', 'chmod 0700 "$d"']);
    }
    // 秘密值不出現在 echo、命令列參數或 Groovy 插值中。
    expect(code).not.toMatch(/echo[^\n]*\$\{?LM_SCRUB_VALUE/);
    expect(code).not.toMatch(/\$\{env\.LM_SCRUB_VALUE/);
    expect(code).not.toMatch(/--[a-z-]+ "?\$\{?LM_SCRUB_VALUE/);
    // 收尾無法取得秘密時只記錄憑證 ID。
    expect(functionBody('List stageScrubSecrets()')).toMatch(/catch \(Exception e\) \{[\s\S]*missing << \(s\.id/);
  });

  test('各階段 Ephemeral_Database 的秘密在刪除前以 0600 保存到建置層級目錄；保存失敗時收尾不封存（fail closed）', () => {
    const remove = functionBody('void removeEphemeralDbSecrets()');
    inOrder(remove, [
      'set +x', 'umask 077', '"$WORKSPACE_TMP"/lm-edb-*)', 'mkdir -p -m 0700 "$WORKSPACE_TMP/lm-scrub-secrets"',
      'cp "$LM_EDB_DIR/scrub-secrets.json" "$WORKSPACE_TMP/lm-scrub-secrets/${LM_EDB_DIR##*/}.json"', 'rm -rf -- "$LM_EDB_DIR"',
    ]);
    expect(remove).toMatch(/if \(rc != 0\) \{\s*[^\n]*\n\s*env\.LM_SCRUB_INCOMPLETE = 'true'\s*error\(/);
    // 秘密目錄在遮罩後與 cleanup 刪除。
    expect(functionBody('void removeScrubSecrets()')).toContain('rm -rf -- "$WORKSPACE_TMP/lm-scrub-secrets"');
    expect(functionBody('void removePostWork()')).toContain('rm -rf -- "$WORKSPACE_TMP/lm-post" "$WORKSPACE_TMP/lm-scrub-secrets" "$WORKSPACE_TMP/lm-keep-log"');
  });

  test('觸及秘密或 token 的收尾腳本第一行一律 set +x', () => {
    const scripts = tripleScripts.filter((s) => /LM_SCRUB_|lm-scrub-secrets|LM_KEEP_(DIR|TOKEN|USER)/.test(s));
    expect(scripts.length).toBeGreaterThanOrEqual(8);
    for (const s of scripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
  });

  test('依 label lm.ci.build=$BUILD_TAG 只清除本建置的容器、網路與卷，並確認沒有殘留（Req 2.6）', () => {
    for (const s of [
      'label="lm.ci.build=$BUILD_TAG"',
      'docker ps -aq --filter "label=$label"', 'docker rm -fv "$id"',
      'docker network ls -q --filter "label=$label"', 'docker network rm "$net"',
      'docker volume ls -q --filter "label=$label"', 'docker volume rm -f "$vol"',
      'exit 1',
    ]) expect(resources).toContain(s);
    expect(code).not.toMatch(/docker (system|container|network|volume|image) prune/);
    expect(resources).toContain("timeout(time: 5, unit: 'MINUTES')");
    // 映像層級 Smoke_Test 的容器與網路也以完整建置標籤標記（不使用截斷後的名稱）。
    const smoke = readFileSync(resolve(root, 'ci/scripts/image-smoke.sh'), 'utf8');
    expect(smoke).toContain('--label "lm.ci.build=${label}"');
  });

  test('keepLog：只在 Release_Tag 建置通過觀察期後，以專用帳號經 0600 token 檔呼叫 ci/keep-log.mjs（Req 21.6）', () => {
    expect(/LM_JENKINS_RETENTION_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-jenkins-api-retention');
    expect(keep).toContain("env.LM_TRUSTED != 'true' || env.LM_TRIGGER_KIND != 'release_tag' || env.LM_PRD_OBSERVED != 'true'");
    inOrder(keep, [
      'credentialsId: env.LM_JENKINS_RETENTION_CREDENTIALS', 'set +x', 'umask 077', 'mkdir -m 0700 "$LM_KEEP_DIR"',
      `printf '%s' "$LM_KEEP_TOKEN_SRC" > "$LM_KEEP_DIR/token"`, 'inBuildImage {', 'LM_JENKINS_API_TOKEN_FILE="$LM_KEEP_DIR/token"',
      'bun ci/keep-log.mjs "$@"', 'finally {', 'rm -rf -- "$LM_KEEP_DIR"',
    ]);
    expect(keep).toContain('--main-record reports/release/main-build-record.json');
    expect(code.match(/credentialsId: env\.LM_JENKINS_RETENTION_CREDENTIALS/g)?.length).toBe(1);
    // keepLog 失敗只寫入摘要，不改變建置結果（Production 已切換）。
    expect(keep).not.toMatch(/currentBuild\.result|error\(/);
  });

  test('最終通知：所有收尾步驟後以當下結果呼叫 notifyAll，附失敗階段與 Release_Gate 說明（Req 22.2–22.4、22.7、22.8）', () => {
    inOrder(notify, [
      "env.LM_POST_RESULT_BEFORE == 'SUCCESS' ? (env.LM_POST_FAILED_STEP ?: '') : ''",
      'finalOutcome(currentBuild.currentResult',
      "gateSummaryText(readJsonFile('reports/build-record.json'), env.BUILD_URL ?: '')",
      'postNotifier()',
      "notifier.notifyAll(o.notify, [commit: env.GIT_COMMIT_FULL ?: '', failedStage: o.failedStage, gateSummary: gate])",
    ]);
    // 關卡說明只讀取遮罩後的封存副本，並跳脫 HTML。
    expect(notify).toContain('dir("${env.WORKSPACE_TMP}/lm-post/archive")');
    expect(functionBody('String gateSummaryText(Map record, String buildUrl)')).toContain('return htmlText(s)');
    expect(notify).toMatch(/catch \(Exception e\) \{\s*failure = e\.getClass\(\)\.getName\(\)\s*\}\s*if \(failure != null\) \{\s*echo "notifyFinal\/notify: \$\{failure\}"\s*echo '最終狀態通知失敗/);
    // Init 尚未載入 notify.groovy 時於收尾載入。
    expect(functionBody('def postNotifier()')).toContain("load('ci/notify.groovy')");
    expect([...code.matchAll(/\.notifyAll\(/g)].length).toBe(2);
  });
});

describe('同主機部署值（design.md 第 18.6 節）', () => {
  const envValue = (text, name) => new RegExp(`^\\s*${name} = '([^']*)'$`, 'm').exec(text)?.[1];

  test('Jenkinsfile、rollback 與 restore-drill 的 Deploy_Host 為 192.168.1.121:22，不再有佔位符', () => {
    for (const file of ['Jenkinsfile', 'ci/jenkins/pipelines/rollback.Jenkinsfile', 'ci/jenkins/pipelines/restore-drill.Jenkinsfile']) {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect({ file, host: envValue(text, 'LM_DEPLOY_HOST'), port: envValue(text, 'LM_DEPLOY_PORT') })
        .toEqual({ file, host: '192.168.1.121', port: '22' });
      expect({ file, placeholder: /deploy-host\.lan\.example|<deploy-host-ip>|<registry-ip>|<jenkins-ip>/.test(text) })
        .toEqual({ file, placeholder: false });
    }
  });

  test('Smoke_Test 的 LAN origin 與 Database 名稱', () => {
    expect(envValue(source, 'LM_STAGING_URL')).toBe('http://192.168.1.121:8081');
    expect(envValue(source, 'LM_PROD_URL')).toBe('http://192.168.1.121:8082');
    expect(envValue(source, 'LM_STAGING_DB_NAME')).toBe('little_moments_staging');
    expect(envValue(source, 'LM_PROD_DB_NAME')).toBe('little_moments');
    // 兩個 URL 都通過 assertStagingConfig／assertProductionConfig 的格式檢查。
    const urlRe = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$/;
    for (const name of ['LM_STAGING_URL', 'LM_PROD_URL']) expect(urlRe.test(envValue(source, name))).toBe(true);
  });
});
