// `cargo test --workspace` 的 libtest 輸出 → JUnit XML（plan.md D15）；QA 關卡以 ci/gates.mjs junit 讀取。
// 純函式供測試使用；CLI 只在直接執行時啟動。
//
// 用法：bun ci/cargo-junit.mjs --log <cargo-test.log> --out <junit.xml> [--exit <cargo 結束碼>]
//   --log   cargo test 的 stdout 與 stderr（例如 `cargo test --workspace --locked > cargo-test.log 2>&1`）
//   --exit  cargo test 的結束碼；非 0 但沒有解析到任何失敗時，加入一個 error 測試案例（fail closed）
// 結束碼：0 已寫入 JUnit（測試是否通過由 QA 關卡判定）；2 參數無效或檔案無法讀寫。
//
// 解析的行（libtest 的 pretty 格式；ANSI 色碼與 CR 先移除）：
//   `     Running <說明> (<路徑>/deps/<名稱>-<hash>)`  一個測試執行檔的開始 → 一個 <testsuite>
//   `   Doc-tests <crate>`                              doc test 的開始 → 一個 <testsuite>
//   `test <名稱> ... ok|FAILED|ignored[, <原因>]`        一個測試案例
//   `---- <名稱> stdout ----` 之後到下一個區塊之前       失敗測試的輸出（寫入 <failure>，最多 MAX_OUTPUT 字元）
//   `test result: ok|FAILED. N passed; N failed; N ignored; …`  該測試執行檔的摘要
// 以下情況各加入一個 error 測試案例（fail closed）：測試執行檔開始後沒有摘要（當掉或被中止）、摘要的通過／失敗／
// 略過數與解析到的測試案例不符、cargo 結束碼非 0 但沒有任何失敗或錯誤（例如編譯錯誤）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_OUTPUT = 16000;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const RUNNING = /^\s+Running (.+?) \((?:.*[\\/])?([^\\/()]+?)(?:-[0-9a-f]{16})?(?:\.exe)?\)\s*$/;
const DOC_TESTS = /^\s+Doc-tests (\S+)\s*$/;
const TEST_LINE = /^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?(?: <[^>]*>)?\s*$/;
const RESULT = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/;
const OUTPUT_HEADER = /^---- (.+?) (?:stdout|stderr) ----\s*$/;

/**
 * @param {string} log cargo test 的輸出
 * @param {{exitCode?: number|null}} [options]
 * @returns {{suites: {name: string, cases: {name: string, status: 'pass'|'fail'|'skipped'|'error', message?: string, output?: string}[]}[]}}
 */
export function parseCargoTest(log, { exitCode = null } = {}) {
  const lines = String(log ?? '').replace(ANSI, '').split(/\r?\n/);
  const suites = [];
  let current = null;
  let capture = null; // { suite, name, text: [] }

  const finishCapture = () => {
    if (!capture) return;
    capture.suite.outputs.set(capture.name, capture.text.join('\n').trim());
    capture = null;
  };
  const finishSuite = () => {
    finishCapture();
    if (current && !current.summary) {
      current.cases.push({ name: '(未完成)', status: 'error', message: '測試執行檔沒有輸出 test result 摘要（可能當掉或被中止）' });
    }
    current = null;
  };
  const start = (name) => {
    finishSuite();
    current = { name, cases: [], outputs: new Map(), summary: null };
    suites.push(current);
  };

  for (const line of lines) {
    let m;
    if ((m = RUNNING.exec(line))) { start(`${m[2]} (${m[1]})`); continue; }
    if ((m = DOC_TESTS.exec(line))) { start(`${m[1]} (doc-tests)`); continue; }
    if (!current) continue;
    if ((m = OUTPUT_HEADER.exec(line))) { finishCapture(); capture = { suite: current, name: m[1], text: [] }; continue; }
    if ((m = RESULT.exec(line))) {
      finishCapture();
      current.summary = { passed: Number(m[2]), failed: Number(m[3]), ignored: Number(m[4]) };
      continue;
    }
    if (/^failures:\s*$/.test(line)) { finishCapture(); continue; }
    if (capture) { capture.text.push(line); continue; }
    if ((m = TEST_LINE.exec(line))) {
      const status = m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skipped';
      current.cases.push({ name: m[1], status });
    }
  }
  finishSuite();

  for (const suite of suites) {
    for (const c of suite.cases) {
      if (c.status !== 'fail') continue;
      c.message = 'FAILED';
      const output = suite.outputs.get(c.name);
      if (output) c.output = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…（輸出已截斷）` : output;
    }
    const s = suite.summary;
    if (s) {
      const count = (st) => suite.cases.filter((c) => c.status === st).length;
      if (s.passed !== count('pass') || s.failed !== count('fail') || s.ignored !== count('skipped')) {
        suite.cases.push({
          name: '(摘要不符)', status: 'error',
          message: `test result 為 ${s.passed} passed、${s.failed} failed、${s.ignored} ignored，與解析到的測試案例不符`,
        });
      }
    }
    delete suite.outputs;
    delete suite.summary;
  }

  const anyProblem = suites.some((s) => s.cases.some((c) => c.status === 'fail' || c.status === 'error'));
  if (exitCode !== null && exitCode !== 0 && !anyProblem) {
    suites.push({
      name: 'cargo test',
      cases: [{
        name: '(cargo test 失敗)', status: 'error',
        message: suites.length === 0
          ? `cargo test 結束碼 ${exitCode}，沒有執行任何測試（例如編譯錯誤）`
          : `cargo test 結束碼 ${exitCode}，但沒有解析到失敗的測試`,
      }],
    });
  }
  return { suites };
}

function xmlEscape(text) {
  return String(text)
    // XML 1.0 不允許的控制字元
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function counts(cases) {
  return {
    tests: cases.length,
    failures: cases.filter((c) => c.status === 'fail').length,
    errors: cases.filter((c) => c.status === 'error').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
}

const attrs = (c) => `tests="${c.tests}" failures="${c.failures}" errors="${c.errors}" skipped="${c.skipped}"`;

/** parseCargoTest 的結果 → JUnit XML（<testsuites> 帶總數，ci/gates.mjs 的 parseJunitSummary 採用其屬性）。 */
export function toJunit({ suites }) {
  const total = counts(suites.flatMap((s) => s.cases));
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="cargo test" ${attrs(total)}>`];
  for (const suite of suites) {
    out.push(`  <testsuite name="${xmlEscape(suite.name)}" ${attrs(counts(suite.cases))}>`);
    for (const c of suite.cases) {
      const head = `    <testcase classname="${xmlEscape(suite.name)}" name="${xmlEscape(c.name)}"`;
      if (c.status === 'pass') out.push(`${head}/>`);
      else if (c.status === 'skipped') out.push(`${head}><skipped/></testcase>`);
      else {
        const tag = c.status === 'fail' ? 'failure' : 'error';
        out.push(`${head}><${tag} message="${xmlEscape(c.message ?? '')}">${xmlEscape(c.output ?? '')}</${tag}></testcase>`);
      }
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return `${out.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = { log: null, out: null, exit: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--log', '--out', '--exit'].includes(key) || value === undefined || value === '') return null;
    opts[key.slice(2)] = value;
  }
  if (!opts.log || !opts.out) return null;
  if (opts.exit !== null) {
    if (!/^\d{1,3}$/.test(opts.exit)) return null;
    opts.exit = Number(opts.exit);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  if (!opts) {
    error('用法：bun ci/cargo-junit.mjs --log <cargo-test.log> --out <junit.xml> [--exit <cargo 結束碼>]');
    return 2;
  }
  let text;
  try {
    text = readFileSync(opts.log, 'utf8');
  } catch {
    error(`無法讀取 ${opts.log}`);
    return 2;
  }
  const parsed = parseCargoTest(text, { exitCode: opts.exit });
  try {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, toJunit(parsed));
  } catch {
    error(`無法寫入 ${opts.out}`);
    return 2;
  }
  log(JSON.stringify({ suites: parsed.suites.length, ...counts(parsed.suites.flatMap((s) => s.cases)) }));
  return 0;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
