// Jenkinsfile 的 CPS 序列化與 JSON 解析（Components 第 23.5 節；Req 1.1、1.7、15.4）。
// CPS 函式在 step 執行期間會把程式狀態序列化存檔；此時 continuation 若持有不可序列化的物件（例如 JsonSlurperClassic），
// 存檔丟出 NotSerializableException。本機無法執行 CPS，以文字規則檢查已知的寫法：
//   1. JsonSlurperClassic 只在 @NonCPS parseJsonText 中建立；parseText( 只出現在其中；import 若且唯若有 parseJsonText
//   2. @NonCPS 函式的引數不直接以 readFile( 或 sh( 開頭
//   3. CPS 函式中沒有 =~、.matcher(、.iterator(
//   4. @NonCPS 函式中沒有 step 呼叫
//   5. CPS 中吸收例外的 catch 只記下例外類別，並在 catch 之後以 "<函式名稱>… 開頭的 echo 輸出
//   6. 不輸出例外訊息、toString、cause 或堆疊
//   7. JsonOutput.toJson( 的引數是 Map 字面值或以 Map 宣告的變數
// 已知限制：其他不可序列化的型別（例如 plugin API 回傳的物件）無法以文字判斷，列為程式碼審查項目。
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanGroovy } from './support/groovy-scan.js';

const root = resolve(import.meta.dir, '..');
const PIPELINE_DIR = 'ci/jenkins/pipelines';
const FILES = [
  'Jenkinsfile',
  ...readdirSync(resolve(root, PIPELINE_DIR)).filter((f) => f.endsWith('.Jenkinsfile')).sort().map((f) => `${PIPELINE_DIR}/${f}`),
  'ci/notify.groovy',
];
// Windows 以 core.autocrlf 檢出時工作目錄可能是 CRLF；repository 內為 LF。
const read = (f) => readFileSync(resolve(root, f), 'utf8').replace(/\r\n/g, '\n');

/** 延後重新拋出：把例外存入變數，之後由同一函式拋出（Components 第 23.3 節）。 */
const DEFERRED_RETHROW = { Jenkinsfile: ['deployStaging', 'deployProduction', 'waitForApproval'] };

const STEPS = ['echo', 'sh', 'readFile', 'writeFile', 'fileExists', 'error', 'input', 'sleep', 'load', 'dir', 'withEnv',
  'withCredentials', 'timeout', 'catchError', 'retry', 'archiveArtifacts', 'githubNotify'];
const STEP_RE = new RegExp(String.raw`(?<![\w.$])(${STEPS.join('|')})\s*[('"]`);
const CATCH_RE = /catch\s*\(\s*(?:(?:Exception|Throwable)\s+)?([A-Za-z_]\w*)\s*\)\s*\{/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** masked 中 open 位置的括號對應的結束位置。 */
function matching(masked, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (c in pairs) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) throw new Error(`第 ${masked.slice(0, k).split('\n').length} 行括號不配對`);
      if (stack.length === 0) return k;
    }
  }
  throw new Error('括號未結束');
}

/**
 * 依第 23.5 節的七條規則檢查一個 Groovy 檔；回傳違規清單（`<檔名>:<行號>: 規則 N：…`）。
 * 以 masked 文字（註解與字串內容為空白）判斷程式結構，以原文判斷 echo 字串與 GString。
 */
function cpsViolations(file, text) {
  const { blocks, masked } = scanGroovy(text);
  const lines = text.split('\n');
  const offsets = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  const out = [];
  const fail = (i, rule, msg) => out.push(`${file}:${lineAt(i)}: 規則 ${rule}：${msg}`);

  const units = blocks.map((b) => ({
    ...b,
    from: offsets[b.start - 1],
    to: offsets[b.end],
    noncps: b.kind === 'function' && b.start >= 2 && lines[b.start - 2].trim() === '@NonCPS',
  }));
  const unitAt = (i) => units.find((u) => i >= u.from && i < u.to);
  const nonCpsNames = units.filter((u) => u.noncps).map((u) => u.name);

  // 規則 1：JsonSlurperClassic 只在 @NonCPS parseJsonText 中建立。
  const parsers = units.filter((u) => u.kind === 'function' && u.name === 'parseJsonText');
  if (parsers.length > 1) fail(parsers[1].from, 1, 'parseJsonText 定義超過一次');
  for (const p of parsers) if (!p.noncps) fail(p.from, 1, 'parseJsonText 必須是 @NonCPS');
  const inParser = (i) => { const u = unitAt(i); return Boolean(u && u.name === 'parseJsonText' && u.noncps); };
  const slurpers = [...masked.matchAll(/new\s+JsonSlurperClassic\b/g)];
  if (slurpers.length > 1) fail(slurpers[1].index, 1, 'new JsonSlurperClassic 出現超過一次');
  for (const m of slurpers) if (!inParser(m.index)) fail(m.index, 1, 'new JsonSlurperClassic 不在 @NonCPS parseJsonText 中');
  for (const m of masked.matchAll(/\bparseText\s*\(/g)) if (!inParser(m.index)) fail(m.index, 1, 'parseText( 不在 parseJsonText 中');
  for (const m of masked.matchAll(/\bJsonSlurper(?!Classic)\b/g)) fail(m.index, 1, '使用 JsonSlurper（非 Classic）');
  const hasImport = /^import\s+groovy\.json\.JsonSlurperClassic\s*$/m.test(masked);
  if (hasImport !== (parsers.length > 0)) fail(0, 1, hasImport ? '有 import JsonSlurperClassic 但沒有 parseJsonText' : '有 parseJsonText 但沒有 import JsonSlurperClassic');

  // 規則 2：@NonCPS 函式的引數不直接以 step 開頭。
  for (const name of nonCpsNames) {
    for (const m of masked.matchAll(new RegExp(String.raw`(?<![\w.])${esc(name)}\s*\(\s*(readFile|sh)\s*\(`, 'g'))) {
      fail(m.index, 2, `${name}( 的引數直接是 ${m[1]}(；先把結果存入 String 變數`);
    }
  }

  for (const u of units) {
    const body = masked.slice(u.from, u.to);
    const at = (k) => u.from + k;
    if (u.noncps) {
      // 規則 4：@NonCPS 函式中沒有 step 呼叫（略過宣告行）。
      const open = body.indexOf('{');
      const m = STEP_RE.exec(body.slice(open));
      if (m) fail(at(open + m.index), 4, `@NonCPS ${u.name} 呼叫 step ${m[1]}`);
      continue;
    }
    // 規則 3：CPS 函式中沒有不可序列化的 Matcher／Iterator。
    for (const m of body.matchAll(/(?<![=!])=~|\.matcher\s*\(|\.iterator\s*\(/g)) fail(at(m.index), 3, `CPS ${u.name} 使用 ${m[0].trim()}`);
    // 規則 5：CPS 中 catch (Exception x)、catch (Throwable x)、catch (x)。
    for (const m of body.matchAll(CATCH_RE)) {
      const x = m[1];
      const open = m.index + m[0].length - 1;
      const close = matching(body, open);
      const inner = body.slice(open + 1, close);
      if (new RegExp(String.raw`\bthrow\s+${esc(x)}\b`).test(inner)) continue;
      if ((DEFERRED_RETHROW[file] ?? []).includes(u.name) && /\bthrow\b/.test(body)) continue;
      if (!inner.includes(`${x}.getClass().getName()`)) fail(at(m.index), 5, `${u.name} 吸收例外但沒有記下 ${x}.getClass().getName()`);
      const step = STEP_RE.exec(inner);
      if (step) fail(at(open + 1 + step.index), 5, `${u.name} 的 catch 本體呼叫 step ${step[1]}`);
      // 字串以 "<函式名稱> 或 '<函式名稱> 開頭（ci/jenkins/pipelines/ 的 Jenkinsfile 不使用雙引號字串，以 ' 串接）。
      const echoed = [...body.slice(close).matchAll(/(?<![\w.$])echo\s*\(?\s*(["'])/g)]
        .some((e) => text.startsWith(`${e[1]}${u.name}`, at(close + e.index + e[0].length - 1)));
      if (!echoed) fail(at(m.index), 5, `${u.name} 的 catch 之後沒有以 "${u.name} 開頭的 echo`);
    }
  }

  // 規則 6：不輸出例外訊息、toString、cause 或堆疊（所有 catch，含 @NonCPS 與型別限定的 catch）。
  for (const m of masked.matchAll(/catch\s*\(\s*(?:[\w.]+\s+)?([A-Za-z_]\w*)\s*\)\s*\{/g)) {
    const x = esc(m[1]);
    const open = m.index + m[0].length - 1;
    const close = matching(masked, open);
    const code = masked.slice(open + 1, close);
    const raw = text.slice(open + 1, close);
    const bad = new RegExp(String.raw`(?<![\w.])${x}\s*\.\s*(message\b|getMessage\s*\(|toString\s*\(|cause\b|getCause\s*\()`).exec(code)
      ?? new RegExp(String.raw`\$\{\s*${x}\s*[}.?]|\$${x}\b`).exec(raw);
    if (bad) fail(open + 1 + bad.index, 6, `例外變數 ${m[1]} 以 ${bad[0].trim()} 的形式使用`);
  }
  for (const m of masked.matchAll(/printStackTrace/g)) fail(m.index, 6, '使用 printStackTrace');

  // 規則 7：JsonOutput.toJson( 的引數是 Map 字面值或以 Map 宣告的變數。
  for (const m of masked.matchAll(/JsonOutput\.toJson\s*\(\s*/g)) {
    const argAt = m.index + m[0].length;
    if (masked[argAt] === '[') {
      if (!masked.slice(argAt, matching(masked, argAt)).includes(':')) fail(m.index, 7, 'JsonOutput.toJson 的 List 字面值引數');
      continue;
    }
    const id = /^([A-Za-z_]\w*)\s*\)/.exec(masked.slice(argAt));
    const u = unitAt(m.index);
    const declared = id && u && new RegExp(String.raw`\bMap\s+${esc(id[1])}\b`).test(masked.slice(u.from, u.to));
    if (!declared) fail(m.index, 7, 'JsonOutput.toJson 的引數不是 Map 字面值或以 Map 宣告的變數');
  }
  return out;
}

const rules = (v) => [...new Set(v.map((s) => Number(/規則 (\d)/.exec(s)[1])))].sort();
const sample = (...l) => l.join('\n') + '\n';
const PARSER = ['@NonCPS', 'Object parseJsonText(String text) {', '  return new JsonSlurperClassic().parseText(text)', '}'];
const IMPORT = 'import groovy.json.JsonSlurperClassic';

describe('CPS 規則（固定樣本）', () => {
  test('規則 1：JsonSlurperClassic 只在 @NonCPS parseJsonText；import 若且唯若有 parseJsonText', () => {
    expect(cpsViolations('S', sample(IMPORT, ...PARSER))).toEqual([]);
    expect(cpsViolations('S', sample('void f() {', '  echo "x"', '}'))).toEqual([]);
    expect(rules(cpsViolations('S', sample(IMPORT, 'Map f(String t) {', '  return new JsonSlurperClassic().parseText(t)', '}')))).toEqual([1]);
    expect(rules(cpsViolations('S', sample(IMPORT, 'Object parseJsonText(String text) {', '  return new JsonSlurperClassic().parseText(text)', '}')))).toEqual([1]);
    expect(rules(cpsViolations('S', sample(...PARSER)))).toEqual([1]);
    expect(rules(cpsViolations('S', sample(IMPORT, 'void f() {', '}')))).toEqual([1]);
    expect(rules(cpsViolations('S', sample(IMPORT, ...PARSER, '@NonCPS', 'Object g(String t) {', '  return new groovy.json.JsonSlurper().parse(t)', '}')))).toEqual([1]);
  });

  test('規則 2：@NonCPS 函式的引數不直接以 readFile( 或 sh( 開頭', () => {
    expect(cpsViolations('S', sample(IMPORT, ...PARSER, 'Map f(String p) {', '  String text = readFile(p)', '  return parseJsonText(text)', '}'))).toEqual([]);
    expect(rules(cpsViolations('S', sample(IMPORT, ...PARSER, 'Map f(String p) {', '  return parseJsonText(readFile(p))', '}')))).toEqual([2]);
    expect(rules(cpsViolations('S', sample(IMPORT, ...PARSER, 'def f() {', "  return parseJsonText( sh(returnStdout: true, script: 'x'))", '}')))).toEqual([2]);
    // 舊寫法 parseText(readFile(…)) 同時違反規則 1。
    expect(rules(cpsViolations('S', sample(IMPORT, 'Map f(String p) {', '  return new JsonSlurperClassic().parseText(readFile(p))', '}')))).toEqual([1]);
  });

  test('規則 3：CPS 函式中沒有 =~、.matcher(、.iterator(；==~ 與 @NonCPS 中的使用不受限', () => {
    expect(cpsViolations('S', sample('boolean f(String s) {', '  return s ==~ /^a$/', '}', '@NonCPS', 'String g(String s) {', '  def m = s =~ /a/', '  return m ? m[0] : null', '}'))).toEqual([]);
    expect(rules(cpsViolations('S', sample('String f(String s) {', '  def m = s =~ /a(b)/', "  sh 'true'", '  return m[0][1]', '}')))).toEqual([3]);
    expect(rules(cpsViolations('S', sample('void f(List xs) {', '  def it = xs.iterator()', '}')))).toEqual([3]);
    expect(rules(cpsViolations('S', sample('void f(java.util.regex.Pattern p) {', "  def m = p.matcher('x')", '}')))).toEqual([3]);
  });

  test('規則 4：@NonCPS 函式中沒有 step 呼叫', () => {
    expect(cpsViolations('S', sample('@NonCPS', 'Map f(String s) {', "  return [error: s, echoed: 'x']", '}'))).toEqual([]);
    expect(rules(cpsViolations('S', sample('@NonCPS', 'void f() {', "  echo 'x'", '}')))).toEqual([4]);
    expect(rules(cpsViolations('S', sample('@NonCPS', 'String f() {', "  return sh(returnStdout: true, script: 'date')", '}')))).toEqual([4]);
  });

  test('規則 5：吸收例外的 catch 記下類別、不呼叫 step，之後以 "<函式名稱> 開頭的 echo 輸出', () => {
    const ok = sample(
      'int f() {', '  int rc = 0', '  String failure = null', '  try {', "    sh 'x'", '  } catch (Exception e) {',
      '    failure = e.getClass().getName()', '    rc = 2', '  }', '  if (failure != null) {', '    echo "f: ${failure}"', "    echo '固定訊息'", '  }', '  return rc', '}',
    );
    expect(cpsViolations('S', ok)).toEqual([]);
    expect(cpsViolations('S', ok.replace('echo "f: ${failure}"', "echo('f: ' + failure)"))).toEqual([]);
    // 重新拋出、型別限定的 catch、延後重新拋出（明列的函式）不受限。
    expect(cpsViolations('S', sample('void f() {', '  try {', "    sh 'x'", '  } catch (err) {', "    echo 'x'", '    throw err', '  }', '}'))).toEqual([]);
    expect(cpsViolations('S', sample('void f() {', '  try {', "    sh 'x'", '  } catch (MissingPropertyException ignored) {', "    echo 'x'", '  }', '}'))).toEqual([]);
    const deferred = sample('void deployStaging() {', '  def interrupted = null', '  try {', "    sh 'x'", '  } catch (err) {', '    interrupted = err', '  }', '  if (interrupted != null) {', '    throw interrupted', '  }', '}');
    expect(cpsViolations('Jenkinsfile', deferred)).toEqual([]);
    expect(rules(cpsViolations('S', deferred))).toEqual([5]);
    // 沒有輸出類別的吸收型 catch。
    expect(rules(cpsViolations('S', sample('Map f() {', '  try {', "    sh 'x'", '  } catch (Exception ignored) {', '    return [:]', '  }', '  return [a: 1]', '}')))).toEqual([5]);
    // 在 catch 本體內呼叫 echo。
    expect(rules(cpsViolations('S', sample('void f() {', '  try {', "    sh 'x'", '  } catch (Throwable e) {', '    String failure = e.getClass().getName()', '    echo "f: ${failure}"', '  }', '}')))).toEqual([5]);
    // catch 之後的 echo 不以函式名稱開頭。
    expect(rules(cpsViolations('S', ok.replace('echo "f: ${failure}"', 'echo "g: ${failure}"')))).toEqual([5]);
    // 註解中的 echo 不算。
    expect(rules(cpsViolations('S', ok.replace('echo "f: ${failure}"', '// echo "f: ${failure}"')))).toEqual([5]);
  });

  test('規則 6：例外變數不以 message、toString、cause、GString 的形式使用；沒有 printStackTrace', () => {
    const base = (line) => sample('void f() {', '  try {', "    sh 'x'", '  } catch (err) {', `    ${line}`, '    throw err', '  }', '}');
    expect(cpsViolations('S', base('String who = inputRejecter(err)'))).toEqual([]);
    expect(rules(cpsViolations('S', base('echo "失敗：${err.message}"')))).toEqual([6]);
    expect(rules(cpsViolations('S', base('echo "失敗：${err}"')))).toEqual([6]);
    expect(rules(cpsViolations('S', base('echo err.toString()')))).toEqual([6]);
    expect(rules(cpsViolations('S', base('def c = err.getCause()')))).toEqual([6]);
    expect(rules(cpsViolations('S', base('err.printStackTrace()')))).toEqual([6]);
    expect(rules(cpsViolations('S', sample('@NonCPS', 'String f(String s) {', '  try {', '    return s.trim()', '  } catch (Exception e) {', '    return e.message', '  }', '}')))).toEqual([6]);
  });

  test('規則 7：JsonOutput.toJson( 的引數是 Map 字面值或以 Map 宣告的變數', () => {
    expect(cpsViolations('S', sample('void f(Map patch) {', '  Map m = [a: 1]', "  writeFile(file: 'a', text: JsonOutput.toJson([reports: m]))", "  writeFile(file: 'b', text: JsonOutput.toJson(m))", "  writeFile(file: 'c', text: JsonOutput.toJson(patch))", '}'))).toEqual([]);
    expect(rules(cpsViolations('S', sample('void f(Object o) {', "  writeFile(file: 'a', text: JsonOutput.toJson(o))", '}')))).toEqual([7]);
    expect(rules(cpsViolations('S', sample('void f() {', "  writeFile(file: 'a', text: JsonOutput.toJson([1, 2]))", '}')))).toEqual([7]);
  });
});

describe('Jenkinsfile、ci/jenkins/pipelines/*.Jenkinsfile 與 ci/notify.groovy 符合 CPS 規則', () => {
  for (const file of FILES) {
    test(file, () => {
      expect(cpsViolations(file, read(file))).toEqual([]);
    });
  }

  test('解析 JSON 的檔案各有一份內容相同的 parseJsonText；digest-lookup 與 notify.groovy 不解析 JSON', () => {
    const parser = (f) => /@NonCPS\nObject parseJsonText\(String text\) \{\n {2}return new JsonSlurperClassic\(\)\.parseText\(text\)\n\}\n/.test(read(f));
    for (const f of ['Jenkinsfile', ...['build-image', 'rollback', 'restore-drill'].map((n) => `${PIPELINE_DIR}/${n}.Jenkinsfile`)]) {
      expect({ f, parser: parser(f) }).toEqual({ f, parser: true });
    }
    for (const f of [`${PIPELINE_DIR}/digest-lookup.Jenkinsfile`, 'ci/notify.groovy']) expect(read(f)).not.toContain('JsonSlurper');
    // parseJsonText 位於輔助函式分隔線之後。
    const root = read('Jenkinsfile');
    expect(root.indexOf('Object parseJsonText(String text)')).toBeGreaterThan(root.search(/^\/\/ -{10,} 輔助函式$/m));
  });

  test('readPlan：readFile 結果先存入 String，失敗與非物件時只輸出例外類別，固定結果不變', () => {
    const text = read('Jenkinsfile');
    const m = /\nMap readPlan\(String path\) \{\n[\s\S]*?\n\}\n/.exec(text);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).toContain('String text = readFile(path)\n    parsed = parseJsonText(text)');
    expect(body).toMatch(/catch \(Exception e\) \{\s*failure = e\.getClass\(\)\.getName\(\)\s*\}/);
    expect(body).toContain('echo "readPlan: ${failure}"');
    expect(body).toContain("echo \"readPlan: 不是 JSON 物件（${parsed == null ? 'null' : parsed.getClass().getName()}）\"");
    expect(body.match(/return \[reject: '階段規劃輸出無效'\]/g)).toHaveLength(2);
  });

  test('rollback／restore-drill 的 readJsonFile：取最後一個非空行移到 @NonCPS lastNonEmptyLine，運算式不變', () => {
    for (const n of ['rollback', 'restore-drill']) {
      const text = read(`${PIPELINE_DIR}/${n}.Jenkinsfile`);
      expect(text).toContain("@NonCPS\nString lastNonEmptyLine(String text) {\n  List lines = text.tokenize('\\n').findAll { it.trim() }\n  return lines.isEmpty() ? null : lines[-1]\n}\n");
      expect(text).toContain('String text = readFile(path)\n    String line = lastNonEmptyLine(text)');
      expect(text).not.toMatch(/readFile\(path\)\.tokenize/);
    }
  });
});
