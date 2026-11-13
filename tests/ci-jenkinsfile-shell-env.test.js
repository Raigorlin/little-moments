// Pipeline 的 sh 腳本在變數未設定時不因 nounset 中止（Components 第 24.4、24.5 節；建置 #8 的 Unit Tests post）。
// Jenkins 會移除值為空字串的環境變數（JENKINS-43632）：withEnv(["X="]) 與 env.X = '' 都讓 X 在 sh 中未設定，
// 所以啟用 nounset（set -u／set -eu／set -o nounset）的腳本必須以 ${X:-…}、${X-…} 或 ${X:+…} 展開可能為空的變數。
//
// 靜態規則：
//   1. 可能為空的變數：withEnv([...]) 中值含 `?:`、三元運算、`''` 或 `.join(` 的項目（或值為空），以及檔案中
//      env.X = '' 或值含上述形式的 env.X = …。
//   2. withEnv 傳入的可能為空變數，在該 withEnv 範圍內啟用 nounset 的單引號腳本中，每次展開都使用預設值形式。
//   3. 第 1 點 env.X 的變數，在檔案中所有啟用 nounset 的單引號腳本裡，空值判斷（[ -n／-z "$X" ]、test -n／-z）
//      與 `for v in $X` 清單展開都使用預設值形式；一般位置的 "$X" 不受限制（保留 set -u 的立即失敗）。
//   4. 每條規則都有通過與失敗的固定樣本，失敗樣本包含 recordQa 的舊寫法。
// 腳本行為：有 POSIX sh（Linux 的 dash／sh，或 Windows 上 WSL 的 dash／sh）時，以 PATH 中的假 bun 執行
// recordQa 的「Release_Gate QA」與 finalizeBuildRecord 的腳本；沒有時以明確的標題略過。
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { scanGroovy } from './support/groovy-scan.js';

const root = resolve(import.meta.dir, '..');
const PIPELINE_DIR = resolve(root, 'ci/jenkins/pipelines');
const FILES = ['Jenkinsfile', ...readdirSync(PIPELINE_DIR).filter((f) => f.endsWith('.Jenkinsfile')).sort().map((f) => `ci/jenkins/pipelines/${f}`)];

const NOUNSET_RE = /(?:^|[\s;&|(])set\s+(?:-[A-Za-z]*u[A-Za-z]*\b|-o\s+nounset\b)/m;
const NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const ENV_ASSIGN_RE = /\benv\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Groovy 字串值是否可能為空：含 `?:`、三元運算、`''`／`""`、`.join(`，或沒有任何內容。 */
function maybeEmptyValue(expr) {
  const v = expr.trim();
  return v === '' || /\?:/.test(v) || /\?(?![:.[])[\s\S]*:/.test(v) || /''|""/.test(v) || /\.join\(/.test(v);
}

/** Groovy 單引號字串的跳脫：`\` + 換行為續行，其餘 `\x` 依 Groovy 規則轉換。 */
function groovyUnescape(raw) {
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  return raw.replace(/\\(\n|.)/g, (_, c) => (c === '\n' ? '' : (map[c] ?? c)));
}

/** 由 masked 文字中 open 位置的括號找出對應的結束位置。 */
function matchBracket(masked, open) {
  const stack = [];
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch in OPEN) stack.push(OPEN[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) throw new Error(`位置 ${k} 的 ${ch} 不配對`);
      if (stack.length === 0) return k;
    }
  }
  throw new Error(`位置 ${open} 的括號未結束`);
}

/** withEnv 參數中 list 常值的元素（原文範圍）。非 list 的參數（testEnv()、extraEnv）沒有可分析的元素。 */
function listElements(masked, from, to) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let k = from; k < to; k++) {
    const ch = masked[k];
    if (ch === '[' && depth === 0) { depth = 1; start = k + 1; continue; }
    if (depth === 0) continue;
    if (ch in OPEN) depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { out.push([start, k]); start = -1; }
    } else if (ch === ',' && depth === 1) { out.push([start, k]); start = k + 1; }
  }
  return out.filter(([a, b]) => masked.slice(a, b).trim() !== '');
}

function lineAt(text, pos) {
  return text.slice(0, pos).split('\n').length;
}

/** 字串變數 name 在腳本 s 中的每次展開：{ index, defaulted }。`\$` 跳脫的不算展開。 */
function expansions(s, name) {
  const re = new RegExp(String.raw`\$(\{)?${name}(?![A-Za-z0-9_])`, 'g');
  const out = [];
  for (const m of s.matchAll(re)) {
    if (m.index > 0 && s[m.index - 1] === '\\') continue;
    const after = s.slice(m.index + m[0].length);
    out.push({ index: m.index, defaulted: Boolean(m[1]) && /^(?::-|-|:\+)/.test(after) });
  }
  return out;
}

/** 空值判斷（[ -n／-z、[[ -n／-z、test -n／-z）或 for 清單中的展開。 */
function emptinessOrListContext(s, index) {
  const prefix = s.slice(s.lastIndexOf('\n', index - 1) + 1, index);
  if (/(?:\[\[?|\btest)\s+(?:!\s+)?-[nz]\s+"?$/.test(prefix)) return 'empty-test';
  // 只算清單本身的字（`for t in a $X`、`for t in "$X"`）；`$(…"$X"…)` 命令替換中的展開不是清單展開。
  if (/\bfor\s+[A-Za-z_]\w*\s+in\s+(?:[^;\n"'`()]*\s)?"?$/.test(prefix)) return 'for-list';
  return null;
}

/**
 * 分析一份 Groovy 原文。回傳：
 *   withEnvVars：withEnv 傳入的可能為空變數 [{ name, start, end }]（start／end 為 withEnv 區塊範圍）
 *   envVars：env.X 可能為空的變數名稱（Set）
 *   scripts：啟用 nounset 的單引號腳本數
 *   violations：[{ rule, name, line, fn }]
 */
function checkShellEnv(text) {
  const { masked, strings, blocks } = scanGroovy(text);
  const fnAt = (pos) => {
    const line = lineAt(text, pos);
    return blocks.find((b) => b.start <= line && line <= b.end)?.name ?? '(頂層)';
  };

  // 規則 1：withEnv 的可能為空項目。
  const withEnvVars = [];
  for (const m of masked.matchAll(/\bwithEnv\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    let k = close + 1;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] !== '{') throw new Error(`第 ${lineAt(text, m.index)} 行的 withEnv 後面沒有區塊`);
    const end = matchBracket(masked, k);
    for (const [a, b] of listElements(masked, open + 1, close)) {
      const lit = strings.find((s) => s.start >= a && s.start < b);
      const nm = lit ? NAME_RE.exec(lit.raw) : null;
      if (!nm) continue;
      const value = lit.raw.slice(nm[0].length) + text.slice(a, lit.start) + text.slice(lit.end, b);
      if (maybeEmptyValue(value)) withEnvVars.push({ name: nm[1], start: k, end });
    }
  }

  // 規則 1：env.X = '' 或值可能為空的 env.X = …。
  const envVars = new Set();
  for (const m of masked.matchAll(ENV_ASSIGN_RE)) {
    const from = m.index + m[0].length;
    const eol = text.indexOf('\n', from);
    if (maybeEmptyValue(text.slice(from, eol < 0 ? text.length : eol))) envVars.add(m[1]);
  }

  const scripts = strings
    .filter((s) => s.quote === "'" || s.quote === "'''")
    .map((s) => ({ ...s, body: groovyUnescape(s.raw) }))
    .filter((s) => NOUNSET_RE.test(s.body));

  const violations = [];
  const report = (rule, name, script, index) => {
    const line = lineAt(text, script.start) + script.body.slice(0, index).split('\n').length - 1;
    violations.push({ rule, name, line, fn: fnAt(script.start) });
  };
  for (const script of scripts) {
    // 規則 2：withEnv 範圍內的每次展開。
    for (const v of withEnvVars) {
      if (script.start < v.start || script.end > v.end) continue;
      for (const e of expansions(script.body, v.name)) if (!e.defaulted) report(2, v.name, script, e.index);
    }
    // 規則 3：env.X 的空值判斷與 for 清單。
    for (const name of envVars) {
      for (const e of expansions(script.body, name)) {
        if (!e.defaulted && emptinessOrListContext(script.body, e.index)) report(3, name, script, e.index);
      }
    }
  }
  return { withEnvVars, envVars, scripts: scripts.length, violations };
}

// ---- 固定樣本（規則 4） ----

const OLD_RECORD_QA = `int recordQa(Map args) {
  int rc
  withEnv([
    "LM_GATE_JUNIT=\${(args.junit ?: []).join(' ')}",
    "LM_GATE_INVENTORY=\${args.inventory ?: ''}",
    "LM_GATE_STAGE_ERROR=\${args.stageError ?: ''}",
  ]) {
    rc = sh(label: 'Release_Gate QA', returnStatus: true, script: '''
      set -eu
      set --
      if [ -n "$LM_GATE_INVENTORY" ]; then set -- "$@" --inventory "$LM_GATE_INVENTORY"; fi
      if [ -n "$LM_GATE_STAGE_ERROR" ]; then set -- "$@" --stage-error "$LM_GATE_STAGE_ERROR"; fi
      rm -f reports/gate-qa.json
      rc=0
      bun ci/gates.mjs junit --gate QA --commit "$GIT_COMMIT_FULL" --out reports/gate-qa.json "$@" $LM_GATE_JUNIT > /dev/null || rc=$?
      bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-qa.json
      exit "$rc"
    ''')
  }
  return rc
}
`;

const NEW_RECORD_QA = OLD_RECORD_QA
  .replace('[ -n "$LM_GATE_INVENTORY" ]', '[ -n "${LM_GATE_INVENTORY:-}" ]')
  .replace('--inventory "$LM_GATE_INVENTORY"', '--inventory "${LM_GATE_INVENTORY:-}"')
  .replace('[ -n "$LM_GATE_STAGE_ERROR" ]', '[ -n "${LM_GATE_STAGE_ERROR:-}" ]')
  .replace('--stage-error "$LM_GATE_STAGE_ERROR"', '--stage-error "${LM_GATE_STAGE_ERROR:-}"')
  .replace('"$@" $LM_GATE_JUNIT', '"$@" ${LM_GATE_JUNIT:-}');

describe('規則 1：可能為空的變數', () => {
  test('withEnv 的 ?:、三元運算、\'\'、.join( 與空值為可能為空；固定值與一般插值不是', () => {
    const src = `void f(String a, List l, boolean pr) {
  withEnv([
    "LM_A=\${a ?: ''}", "LM_B=\${l.join(' ')}", "LM_C=\${pr ? 'x' : 'y'}", 'LM_D=', 'LM_E=' + (a ?: 'z'),
    "LM_OK1=\${a}", 'LM_OK2=1', 'LM_OK3=' + a + '/' + a, "LM_OK4=http://\${a}:5173".toString(),
  ]) {
    sh 'true'
  }
  withEnv(testEnv() + ["LM_F=\${a ?: ''}"]) {
    sh 'true'
  }
  withEnv(extraEnv) {
    sh 'true'
  }
}
`;
    const names = checkShellEnv(src).withEnvVars.map((v) => v.name).sort();
    expect(names).toEqual(['LM_A', 'LM_B', 'LM_C', 'LM_D', 'LM_E', 'LM_F']);
  });

  test("env.X = ''、.join(、?:、三元運算為可能為空；固定值、一般變數與比較不是", () => {
    const src = `void f(List l, String s) {
  env.LM_P = ''
  env.LM_Q = l.join(' ')
  env.LM_R = s ?: ''
  env.LM_S = s ? 'a' : 'b'
  env.LM_OK1 = 'true'
  env.LM_OK2 = s
  env.LM_OK3 = "\${s}/x"
  if (env.LM_OK4 == '') { echo 'x' }
  // env.LM_COMMENT = ''
}
`;
    expect([...checkShellEnv(src).envVars].sort()).toEqual(['LM_P', 'LM_Q', 'LM_R', 'LM_S']);
  });
});

describe('規則 2：withEnv 範圍內的展開', () => {
  test('失敗樣本：recordQa 的舊寫法（建置 #8）', () => {
    const r = checkShellEnv(OLD_RECORD_QA);
    expect(r.scripts).toBe(1);
    const got = r.violations.map((v) => `${v.rule}:${v.name}`).sort();
    expect(got).toEqual(['2:LM_GATE_INVENTORY', '2:LM_GATE_INVENTORY', '2:LM_GATE_JUNIT', '2:LM_GATE_STAGE_ERROR', '2:LM_GATE_STAGE_ERROR']);
    expect(r.violations.every((v) => v.fn === 'recordQa')).toBe(true);
  });

  test('通過樣本：recordQa 的新寫法；未啟用 nounset 或範圍外的腳本不檢查', () => {
    expect(checkShellEnv(NEW_RECORD_QA).violations).toEqual([]);
    const src = `void f(String a) {
  withEnv(["LM_A=\${a ?: ''}"]) {
    sh(script: '''
      set -e
      [ -n "$LM_A" ] && echo "$LM_A"
    ''')
    sh(script: 'set -u; echo "\${LM_A-}" "\${LM_A:+x}" "\${LM_A:-}"')
  }
  sh(script: '''
    set -u
    echo "$LM_A"
  ''')
  withEnv(["LM_B=\${a}"]) {
    sh(script: '''
      set -eu
      [ -n "$LM_B" ] && echo "$LM_B"
    ''')
  }
}
`;
    expect(checkShellEnv(src).violations).toEqual([]);
  });

  test('失敗樣本：set -o nounset 與 pipeline 的字串串接寫法', () => {
    const src = `void f(String a) {
  withEnv(['LM_RB_X=' + (a ?: '')]) {
    sh(script: '''
      set -o nounset
      echo "\${LM_RB_X}" "\${LM_RB_X%%/*}"
    ''')
  }
}
`;
    expect(checkShellEnv(src).violations.map((v) => `${v.rule}:${v.name}`)).toEqual(['2:LM_RB_X', '2:LM_RB_X']);
  });
});

describe('規則 3：env.X 的空值判斷與 for 清單', () => {
  test('失敗樣本：[ -n "$X" ]、test -z "$X" 與 for t in $X', () => {
    const src = `void f(List l) {
  env.LM_P = ''
  env.LM_ARGS = l.join(' ')
  sh(script: '''
    set -u
    if [ -n "$LM_P" ]; then echo x; fi
    test -z "$LM_P" || true
    for t in $LM_ARGS; do echo "$t"; done
  ''')
}
`;
    expect(checkShellEnv(src).violations.map((v) => `${v.rule}:${v.name}`)).toEqual(['3:LM_P', '3:LM_P', '3:LM_ARGS']);
  });

  test('通過樣本：預設值形式；一般位置的 "$X" 保留 set -u 的立即失敗', () => {
    const src = `void f(List l) {
  env.LM_EDB_DIR = ''
  env.LM_ARGS = l.join(' ')
  sh(script: '''
    set -u
    if [ -n "\${LM_EDB_DIR:-}" ]; then rm -rf "$LM_EDB_DIR"; fi
    . "$LM_EDB_DIR/client.env"
    for t in \${LM_ARGS:-}; do echo "$t"; done
  ''')
}
`;
    expect(checkShellEnv(src).violations).toEqual([]);
  });
});

describe('Jenkinsfile 與 ci/jenkins/pipelines/*.Jenkinsfile', () => {
  const results = Object.fromEntries(FILES.map((f) => [f, checkShellEnv(readFileSync(resolve(root, f), 'utf8'))]));

  test('檢查範圍包含主要 Pipeline 與 pipelines/ 下的檔案', () => {
    expect(FILES).toContain('Jenkinsfile');
    expect(FILES.length).toBeGreaterThan(1);
  });

  test('辨識出第 24.4 節盤點的可能為空變數（掃描器沒有漏掉 withEnv 與 env.X）', () => {
    const r = results.Jenkinsfile;
    expect(r.scripts).toBeGreaterThan(50);
    const withEnvNames = new Set(r.withEnvVars.map((v) => v.name));
    for (const n of ['LM_GATE_JUNIT', 'LM_GATE_INVENTORY', 'LM_GATE_STAGE_ERROR', 'LM_SCAN_BASE_REF', 'LM_STG_STAGE_ERROR',
      'LM_PRD_STAGE_ERROR', 'LM_PULL_IMAGES', 'LM_POST_FAILED_STAGE']) expect(withEnvNames).toContain(n);
    for (const n of ['LM_DAST_PROBE_ARGS', 'LM_PRD_BASE_COMMIT']) expect(r.envVars).toContain(n);
  });

  for (const f of FILES) {
    test(`${f}：啟用 nounset 的腳本以預設值形式展開可能為空的變數`, () => {
      expect(results[f].violations).toEqual([]);
    });
  }
});

// ---- 腳本行為測試 ----

/** POSIX sh：Linux 優先 dash；Windows 經 WSL（同樣優先 dash）。回傳 { argv(prefix), sh, toPath } 或 null。 */
function findShell() {
  const ok = (cmd, args) => spawnSync(cmd, args, { timeout: 60_000, encoding: 'utf8' }).status === 0;
  if (process.platform === 'win32') {
    for (const sh of ['dash', 'sh']) {
      if (!ok('wsl.exe', ['-e', sh, '-c', 'exit 0'])) continue;
      const toPath = (p) => {
        const r = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', p.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60_000 });
        if (r.status !== 0) throw new Error(`wslpath 失敗：${r.stderr}`);
        return r.stdout.trim();
      };
      return { prefix: ['wsl.exe', '-e'], sh, toPath, label: `WSL ${sh}` };
    }
    return null;
  }
  for (const sh of ['dash', 'sh']) if (ok(sh, ['-c', 'exit 0'])) return { prefix: [], sh, toPath: (p) => p, label: sh };
  return null;
}

/** 由 Jenkinsfile 的函式 fn 中取出含 marker 的 ''' 腳本（Groovy 跳脫已處理）。 */
function extractScript(text, fn, marker) {
  const { strings, blocks } = scanGroovy(text);
  const block = blocks.find((b) => b.name === fn);
  if (!block) throw new Error(`找不到函式 ${fn}`);
  const lines = text.split('\n');
  const from = lines.slice(0, block.start - 1).join('\n').length;
  const to = lines.slice(0, block.end).join('\n').length;
  const found = strings.filter((s) => s.quote === "'''" && s.start >= from && s.end <= to && s.raw.includes(marker));
  if (found.length !== 1) throw new Error(`${fn} 中含 ${marker} 的腳本數為 ${found.length}`);
  return groovyUnescape(found[0].raw).replace(/\r/g, '');
}

const SHELL = findShell();
const jenkinsfile = readFileSync(resolve(root, 'Jenkinsfile'), 'utf8');
const FAKE_BUN = `#!/bin/sh
printf '%s\\037' "$@" >> "$FAKE_BUN_LOG"
printf '\\n' >> "$FAKE_BUN_LOG"
case "$1" in
  ci/gates.mjs) exit "\${FAKE_GATES_RC:-0}" ;;
esac
exit 0
`;

const describeSh = SHELL ? describe : describe.skip;
describeSh(SHELL ? `腳本行為（${SHELL.label}，假的 bun）` : '腳本行為（略過：找不到 POSIX sh）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-shell-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'bun'), FAKE_BUN);
  chmodSync(join(dir, 'bin', 'bun'), 0o755);
  const p = (x) => SHELL.toPath(join(dir, x));
  let n = 0;

  /** 以 env -i 只傳入 vars 執行腳本（與 Jenkins 的 sh 相同：-xe），回傳結束碼、stderr 與 bun 的參數。 */
  function run(script, vars) {
    n++;
    const work = `work-${n}`;
    mkdirSync(join(dir, work, 'reports'), { recursive: true });
    writeFileSync(join(dir, `script-${n}.sh`), script);
    writeFileSync(join(dir, `bun-${n}.log`), '');
    const env = { PATH: `${p('bin')}:/usr/bin:/bin`, HOME: '/tmp', FAKE_BUN_LOG: p(`bun-${n}.log`), ...vars };
    const argv = [...SHELL.prefix, 'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      SHELL.sh, '-c', 'cd "$1" || exit 99; exec "$0" -xe "$2"', SHELL.sh, p(work), p(`script-${n}.sh`)];
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
    const calls = readFileSync(join(dir, `bun-${n}.log`), 'utf8').split('\n').filter(Boolean)
      .map((l) => l.split('\x1f').slice(0, -1));
    return { code: r.status, stderr: r.stderr ?? '', calls };
  }

  const base = { GIT_COMMIT_FULL: 'a'.repeat(40), LM_RECORD: 'reports/build-record.json' };
  const qa = extractScript(jenkinsfile, 'recordQa', 'bun ci/gates.mjs junit');

  test('對照：recordQa 的舊寫法在 LM_GATE_INVENTORY 未設定時因 nounset 中止（建置 #8）', () => {
    const old = extractScript(OLD_RECORD_QA, 'recordQa', 'bun ci/gates.mjs junit');
    const r = run(old, { ...base, LM_GATE_JUNIT: 'reports/unit-junit.xml' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/LM_GATE_INVENTORY: (parameter not set|unbound variable)/);
    expect(r.calls).toEqual([]);
  });

  test('Release_Gate QA：LM_GATE_INVENTORY／LM_GATE_STAGE_ERROR 未設定時不中止、沒有 --inventory', () => {
    const r = run(qa, { ...base, LM_GATE_JUNIT: 'reports/unit-junit.xml' });
    expect(r.stderr).not.toMatch(/parameter not set|unbound variable/);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      ['ci/gates.mjs', 'junit', '--gate', 'QA', '--commit', 'a'.repeat(40), '--out', 'reports/gate-qa.json', 'reports/unit-junit.xml'],
      ['ci/record.mjs', 'gate', '--record', 'reports/build-record.json', '--result', 'reports/gate-qa.json'],
    ]);
  });

  test('Release_Gate QA：LM_GATE_JUNIT 也未設定時不中止', () => {
    const r = run(qa, base);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toEqual(['ci/gates.mjs', 'junit', '--gate', 'QA', '--commit', 'a'.repeat(40), '--out', 'reports/gate-qa.json']);
  });

  test('Release_Gate QA：已設定時傳入 --inventory、--stage-error 與每個 JUnit 路徑', () => {
    const r = run(qa, {
      ...base,
      LM_GATE_JUNIT: 'reports/unit-junit.xml reports/e2e-junit.xml',
      LM_GATE_INVENTORY: 'reports/qa-inventory.json',
      LM_GATE_STAGE_ERROR: 'Unit Tests failed',
    });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toEqual([
      'ci/gates.mjs', 'junit', '--gate', 'QA', '--commit', 'a'.repeat(40), '--out', 'reports/gate-qa.json',
      '--inventory', 'reports/qa-inventory.json', '--stage-error', 'Unit Tests failed', 'reports/unit-junit.xml', 'reports/e2e-junit.xml',
    ]);
  });

  test('Release_Gate QA：bun ci/gates.mjs 回傳 1 時仍寫入關卡，腳本結束碼為 1', () => {
    const r = run(qa, { ...base, LM_GATE_JUNIT: 'reports/unit-junit.xml', LM_GATE_STAGE_ERROR: 'Unit Tests failed', FAKE_GATES_RC: '1' });
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.slice(0, 2))).toEqual([['ci/gates.mjs', 'junit'], ['ci/record.mjs', 'gate']]);
  });

  test('Build_Record finalize：LM_POST_FAILED_STAGE 未設定時不中止、沒有 --first-failed-stage', () => {
    const fin = extractScript(jenkinsfile, 'finalizeBuildRecord', 'bun ci/record.mjs finalize');
    const r = run(fin, { LM_RECORD: 'reports/build-record.json', LM_POST_STATUS: 'SUCCESS' });
    expect(r.stderr).not.toMatch(/parameter not set|unbound variable/);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([['ci/record.mjs', 'finalize', '--record', 'reports/build-record.json', '--status', 'SUCCESS']]);
  });
});
