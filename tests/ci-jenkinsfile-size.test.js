// Jenkinsfile 方法大小（Components 第 22 節；Req 1.1、1.7、15.2、23.1）。
// Declarative Pipeline 把 `pipeline { … }` 編譯成單一 JVM 方法，bytecode 超過 64 KB 時建置在任何階段前以
// MethodTooLargeException 失敗（JENKINS-37984）。本機無法編譯 Groovy，以行數作為代理指標：pipeline {} ≤ 400 行、
// 每個頂層函式 ≤ 250 行；根目錄 Jenkinsfile 另檢查各 stage 只呼叫頂層函式的形式。
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanGroovy } from './support/groovy-scan.js';

const root = resolve(import.meta.dir, '..');
const PIPELINE_DIR = 'ci/jenkins/pipelines';
const FILES = ['Jenkinsfile', ...readdirSync(resolve(root, PIPELINE_DIR)).filter((f) => f.endsWith('.Jenkinsfile')).sort().map((f) => `${PIPELINE_DIR}/${f}`)];
const read = (f) => readFileSync(resolve(root, f), 'utf8');

const MAX_PIPELINE_LINES = 400;
const MAX_FUNCTION_LINES = 250;

/** 超過門檻的區塊；訊息含檔名、區塊名稱、起訖行號與行數。 */
function sizeViolations(file, blocks, limits = { pipeline: MAX_PIPELINE_LINES, function: MAX_FUNCTION_LINES }) {
  return blocks
    .filter((b) => b.lines > limits[b.kind])
    .map((b) => `${file}: ${b.kind === 'pipeline' ? 'pipeline {}' : `${b.name}()`} 第 ${b.start}–${b.end} 行，共 ${b.lines} 行（上限 ${limits[b.kind]}）`);
}

describe('Groovy 掃描器（固定樣本）', () => {
  test('字串內的括號、heredoc 中第 0 欄的行、跳脫字元都不影響區塊範圍', () => {
    const text = [
      'pipeline {',                         // 1
      "  x = '{'",                          // 2
      '  y = "}\\"{"',                      // 3
      "  z = 'it\\'s }'",                   // 4
      '}',                                  // 5
      'void f(String a) {',                 // 6
      "  sh '''",                           // 7
      '}',                                  // 8
      'EOF {',                              // 9
      "'''",                                // 10
      '  sh """',                           // 11
      '}"""',                               // 12
      '}',                                  // 13
    ].join('\n');
    expect(scanGroovy(text).blocks).toEqual([
      { name: 'pipeline', kind: 'pipeline', start: 1, end: 5, lines: 5 },
      { name: 'f', kind: 'function', start: 6, end: 13, lines: 8 },
    ]);
  });

  test('// 與 /* */ 註解中的括號不影響結果；註解與字串內容在 masked 中換成空白', () => {
    const text = ['// {', '/* } {', '} */', '@NonCPS', 'Map g(List<String> xs) { // }', "  return [a: '}']", '}', 'def h() {', '}', ''].join('\n');
    const { blocks, masked } = scanGroovy(text);
    expect(blocks).toEqual([
      { name: 'g', kind: 'function', start: 5, end: 7, lines: 3 },
      { name: 'h', kind: 'function', start: 8, end: 9, lines: 2 },
    ]);
    expect(masked.length).toBe(text.length);
    expect(masked.split('\n').length).toBe(text.split('\n').length);
    expect(masked).not.toContain("'}'");
    expect(masked).toContain("[a: ' ']");
  });

  test('未結束的字串、註解或括號，以及不在第 0 欄或不單獨成行的結束 } 皆失敗', () => {
    expect(() => scanGroovy("void f() {\n  x = 'abc\n}\n")).toThrow(/字串未結束/);
    expect(() => scanGroovy("void f() {\n  sh '''\n}\n")).toThrow(/字串未結束/);
    expect(() => scanGroovy('void f() {\n  /* x\n}\n')).toThrow(/區塊註解未結束/);
    expect(() => scanGroovy('void f() {\n  if (x) {\n}\n')).toThrow(/括號未結束/);
    expect(() => scanGroovy('void f() {\n  g(]\n}\n')).toThrow(/沒有對應的開括號/);
    expect(() => scanGroovy('void f() {\n  }\n')).toThrow(/第 2 行：f 的結束 } 必須單獨位於一行的第 0 欄/);
    expect(() => scanGroovy('void f() { g() }\n')).toThrow(/第 1 行：f 的結束 }/);
    expect(() => scanGroovy('node {\n}\n')).toThrow(/無法辨識的頂層區塊/);
  });

  test('超過門檻的區塊列出檔名、名稱、起訖行與行數', () => {
    const fn = (n) => ['void big() {', ...Array.from({ length: n - 2 }, () => '  echo 1'), '}'].join('\n');
    expect(sizeViolations('X', scanGroovy(fn(MAX_FUNCTION_LINES)).blocks)).toEqual([]);
    expect(sizeViolations('X', scanGroovy(fn(MAX_FUNCTION_LINES + 1)).blocks)).toEqual([`X: big() 第 1–251 行，共 251 行（上限 ${MAX_FUNCTION_LINES}）`]);
    const pipe = (n) => ['pipeline {', ...Array.from({ length: n - 2 }, () => '  // x'), '}'].join('\n');
    expect(sizeViolations('Y', scanGroovy(pipe(MAX_PIPELINE_LINES)).blocks)).toEqual([]);
    expect(sizeViolations('Y', scanGroovy(pipe(MAX_PIPELINE_LINES + 1)).blocks)).toEqual([`Y: pipeline {} 第 1–401 行，共 401 行（上限 ${MAX_PIPELINE_LINES}）`]);
  });
});

describe('Jenkinsfile 的 pipeline {} 與頂層函式行數', () => {
  for (const file of FILES) {
    test(file, () => {
      const { blocks } = scanGroovy(read(file));
      expect(blocks.filter((b) => b.kind === 'pipeline').length).toBe(1);
      expect(blocks.filter((b) => b.kind === 'function').length).toBeGreaterThan(0);
      expect(sizeViolations(file, blocks)).toEqual([]);
    });
  }
});

describe('根目錄 Jenkinsfile：stage 只呼叫頂層函式（Components 第 22.1 節）', () => {
  const text = read('Jenkinsfile');
  const { blocks, masked } = scanGroovy(text);
  const lines = text.split('\n');
  const mlines = masked.split('\n');
  const pipe = blocks.find((b) => b.kind === 'pipeline');
  const functions = new Map(blocks.filter((b) => b.kind === 'function').map((b) => [b.name, b]));
  /** 以縮排找出 [start, end] 內 `<indent><name> {` 到 `<indent>}` 的子區塊（0 起算行號）；以 masked 判斷，字串內容不算。 */
  const children = (start, end, indent) => {
    const out = [];
    for (let k = start; k <= end; k++) {
      const m = new RegExp(`^${indent}(\\w+)(?:\\('[^']*'\\))? \\{$`).exec(lines[k]);
      if (!m || mlines[k].trim() === '') continue;
      let e = k + 1;
      while (e <= end && mlines[e] !== `${indent}}`) e++;
      expect(e).toBeLessThanOrEqual(end);
      out.push({ kw: m[1], name: /\('([^']*)'\)/.exec(lines[k])?.[1], start: k, end: e, body: lines.slice(k + 1, e) });
      k = e;
    }
    return out;
  };
  const code = (body) => body.filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
  const top = children(pipe.start - 1, pipe.end - 1, '  ');
  const stagesBlock = top.find((c) => c.kw === 'stages');
  const stages = children(stagesBlock.start + 1, stagesBlock.end - 1, '    ');
  const pascal = (name) => name.split(' ').map((w) => (w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1))).join('');

  test('pipeline {} 的直接子區塊與 stage 數量', () => {
    // agent 為單行 `agent { label … }`，不是多行子區塊。
    expect(top.map((c) => c.kw)).toEqual(['options', 'environment', 'stages', 'post']);
    expect(stages.map((s) => s.kw)).toEqual(Array(20).fill('stage'));
  });

  test('每個 stage 的 steps 只有 script { run<階段名稱>Stage() }，且函式存在、依 stage 順序位於 pipeline {} 之後', () => {
    const order = [];
    for (const s of stages) {
      const steps = children(s.start + 1, s.end - 1, '      ').filter((c) => c.kw === 'steps');
      expect({ stage: s.name, steps: steps.map((c) => c.body) }).toEqual({ stage: s.name, steps: [[`        script { run${pascal(s.name)}Stage() }`]] });
      const fn = functions.get(`run${pascal(s.name)}Stage`);
      expect({ stage: s.name, defined: Boolean(fn) }).toEqual({ stage: s.name, defined: true });
      expect(lines[fn.start - 1]).toBe(`void run${pascal(s.name)}Stage() {`);
      expect(lines[fn.start]).toBe(`  enterStage('${s.name}')`);
      order.push(fn.start);
    }
    expect(order[0]).toBeGreaterThan(pipe.end);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const helpers = lines.findIndex((l) => /^\/\/ -{10,} 輔助函式$/.test(l)) + 1;
    expect(helpers).toBeGreaterThan(Math.max(...order));
  });

  test('每個 post 條件區塊只有一個 script { <一個呼叫> }，被呼叫的函式存在', () => {
    const conditions = [];
    for (const s of stages) {
      for (const post of children(s.start + 1, s.end - 1, '      ').filter((c) => c.kw === 'post')) {
        for (const c of children(post.start + 1, post.end - 1, '        ')) conditions.push({ where: `${s.name}/${c.kw}`, c, indent: '          ' });
      }
    }
    const pipelinePost = top.find((c) => c.kw === 'post');
    for (const c of children(pipelinePost.start + 1, pipelinePost.end - 1, '    ')) conditions.push({ where: `pipeline/${c.kw}`, c, indent: '      ' });
    expect(conditions.length).toBeGreaterThan(20);
    for (const { where, c, indent } of conditions) {
      const body = code(c.body);
      const joined = body.join('\n');
      // 單行 `script { f(...) }`，或多行 `script {` + 單一呼叫 + `}`（例如 recordImageReports 的報告清單）。
      const single = new RegExp(`^${indent}script \\{ ([A-Za-z_]\\w*)\\((.*)\\) \\}$`).exec(joined);
      let name = single?.[1];
      if (!single) {
        expect({ where, open: body[0], close: body[body.length - 1] }).toEqual({ where, open: `${indent}script {`, close: `${indent}}` });
        const inner = masked.split('\n').slice(c.start + 2, c.end - 1).filter((l) => l.trim() !== '').join('\n').trim();
        const m = /^([A-Za-z_]\w*)\(/.exec(inner);
        expect({ where, call: Boolean(m) }).toEqual({ where, call: true });
        let depth = 0;
        let close = -1;
        for (let k = m[0].length - 1; k < inner.length; k++) {
          if ('([{'.includes(inner[k])) depth++;
          else if (')]}'.includes(inner[k]) && --depth === 0) { close = k; break; }
        }
        expect({ where, rest: inner.slice(close + 1).trim() }).toEqual({ where, rest: '' });
        name = m[1];
      } else {
        expect({ where, args: /[;{}]/.test(single[2].replace(/'[^']*'/g, '')) }).toEqual({ where, args: false });
      }
      expect({ where, name, defined: functions.has(name) }).toEqual({ where, name, defined: true });
    }
    // 管線層級 post 依序呼叫 pipelinePostAlways()、pipelinePostCleanup()。
    expect(code(pipelinePost.body).map((l) => l.trim())).toEqual([
      'always {', 'script { pipelinePostAlways() }', '}', 'cleanup {', 'script { pipelinePostCleanup() }', '}',
    ]);
  });

  test('每個 when 只有一行 expression { … }', () => {
    let count = 0;
    for (const s of stages) {
      for (const w of children(s.start + 1, s.end - 1, '      ').filter((c) => c.kw === 'when')) {
        count++;
        expect({ stage: s.name, lines: w.body.length }).toEqual({ stage: s.name, lines: 1 });
        expect(w.body[0]).toMatch(/^        expression \{ [^\n]+ \}$/);
      }
    }
    expect(count).toBe(13);
  });
});
