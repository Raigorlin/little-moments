// ci/cargo-junit.mjs：cargo test 的 libtest 輸出 → JUnit XML，ci/gates.mjs 能讀取其摘要（plan.md D15）。
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseCargoTest, toJunit } from '../ci/cargo-junit.mjs';
import { junitGate, parseJunitSummary } from '../ci/gates.mjs';

const PASS = `   Compiling lm-core v2.0.0 (/src/crates/core)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 12.34s
     Running unittests src/lib.rs (target/debug/deps/lm_core-0123456789abcdef)

running 3 tests
test dates::tests::parses_iso ... ok
test model::tests::roundtrip ... ok
test text::tests::slow_case ... ignored, needs a database

test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/main.rs (target/debug/deps/little_moments_server-fedcba9876543210)

running 1 test
test config::tests::rejects_sample_keys ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests lm_core

running 1 test
test crates/core/src/lib.rs - text (line 12) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s

`;

const FAIL = `     Running unittests src/lib.rs (target/debug/deps/lm_core-0123456789abcdef)

running 2 tests
test a::ok_case ... ok
test b::broken <in & out> ... FAILED

failures:

---- b::broken <in & out> stdout ----

thread 'b::broken <in & out>' panicked at crates/core/src/b.rs:10:5:
assertion \`left == right\` failed
  left: 1
 right: 2


failures:
    b::broken <in & out>

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`-p lm-core --lib\`
`;

const COMPILE_ERROR = `   Compiling lm-core v2.0.0 (/src/crates/core)
error[E0425]: cannot find value \`x\` in this scope
error: could not compile \`lm-core\` (lib test) due to 1 previous error
`;

const CRASH = `     Running unittests src/lib.rs (target/debug/deps/lm_core-0123456789abcdef)

running 2 tests
test a::ok_case ... ok
error: test failed, to rerun pass \`-p lm-core --lib\`

Caused by:
  process didn't exit successfully: \`/src/target/debug/deps/lm_core-0123456789abcdef\` (signal: 11, SIGSEGV: invalid memory reference)
`;

const shape = (parsed) => parsed.suites.map((s) => [s.name, s.cases.map((c) => [c.name, c.status])]);

describe('parseCargoTest', () => {
  test('每個測試執行檔與 doc test 各為一個 suite；ok／ignored 對應 pass／skipped', () => {
    const parsed = parseCargoTest(PASS, { exitCode: 0 });
    expect(shape(parsed)).toEqual([
      ['lm_core (unittests src/lib.rs)', [
        ['dates::tests::parses_iso', 'pass'], ['model::tests::roundtrip', 'pass'], ['text::tests::slow_case', 'skipped'],
      ]],
      ['little_moments_server (unittests src/main.rs)', [['config::tests::rejects_sample_keys', 'pass']]],
      ['lm_core (doc-tests)', [['crates/core/src/lib.rs - text (line 12)', 'pass']]],
    ]);
  });

  test('失敗的測試帶 FAILED 與其輸出；ANSI 色碼與 CRLF 不影響解析', () => {
    const colored = FAIL.replace('FAILED\n', '\u001b[31mFAILED\u001b[0m\n').replace(/\n/g, '\r\n');
    const parsed = parseCargoTest(colored, { exitCode: 101 });
    expect(shape(parsed)).toEqual([['lm_core (unittests src/lib.rs)', [['a::ok_case', 'pass'], ['b::broken <in & out>', 'fail']]]]);
    const failed = parsed.suites[0].cases[1];
    expect(failed.message).toBe('FAILED');
    expect(failed.output).toContain('assertion `left == right` failed');
    expect(failed.output).not.toContain('failures:');
  });

  test('編譯錯誤（沒有任何 suite、結束碼非 0）→ 一個 error 測試案例', () => {
    const parsed = parseCargoTest(COMPILE_ERROR, { exitCode: 101 });
    expect(shape(parsed)).toEqual([['cargo test', [['(cargo test 失敗)', 'error']]]]);
    expect(parsed.suites[0].cases[0].message).toContain('沒有執行任何測試');
  });

  test('測試執行檔沒有摘要（當掉）→ error 測試案例', () => {
    const parsed = parseCargoTest(CRASH, { exitCode: 101 });
    expect(shape(parsed)).toEqual([['lm_core (unittests src/lib.rs)', [['a::ok_case', 'pass'], ['(未完成)', 'error']]]]);
  });

  test('摘要數字與解析到的測試案例不符 → error 測試案例', () => {
    const log = PASS.replace('2 passed; 0 failed; 1 ignored', '3 passed; 0 failed; 1 ignored');
    const parsed = parseCargoTest(log, { exitCode: 0 });
    expect(parsed.suites[0].cases.at(-1)).toMatchObject({ name: '(摘要不符)', status: 'error' });
  });

  test('結束碼非 0 但所有測試通過 → error 測試案例；未提供結束碼時不加入', () => {
    expect(parseCargoTest(PASS, { exitCode: 101 }).suites.at(-1).cases).toEqual([
      expect.objectContaining({ name: '(cargo test 失敗)', status: 'error' }),
    ]);
    expect(parseCargoTest(PASS).suites.length).toBe(3);
    expect(parseCargoTest('', {}).suites).toEqual([]);
  });

  test('失敗輸出超過上限時截斷', () => {
    const long = FAIL.replace("assertion `left == right` failed", 'x'.repeat(20000));
    const out = parseCargoTest(long).suites[0].cases[1].output;
    expect(out.length).toBeLessThan(16100);
    expect(out).toContain('輸出已截斷');
  });
});

describe('toJunit 與 ci/gates.mjs', () => {
  test('通過的輸出：parseJunitSummary 讀到總數，QA 關卡通過', () => {
    const xml = toJunit(parseCargoTest(PASS, { exitCode: 0 }));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="cargo test" tests="5" failures="0" errors="0" skipped="1">')).toBe(true);
    expect(xml.match(/<testsuite /g)?.length).toBe(3);
    const summary = parseJunitSummary(xml);
    expect(summary).toEqual({ tests: 5, failures: 0, errors: 0, skipped: 1 });
    expect(junitGate(summary).pass).toBe(true);
  });

  test('失敗與錯誤：屬性與內容經過跳脫，QA 關卡未通過', () => {
    const xml = toJunit(parseCargoTest(FAIL, { exitCode: 101 }));
    expect(xml).toContain('name="b::broken &lt;in &amp; out&gt;"><failure message="FAILED">');
    expect(xml).not.toContain('<in & out>');
    expect(parseJunitSummary(xml)).toEqual({ tests: 2, failures: 1, errors: 0, skipped: 0 });
    expect(junitGate(parseJunitSummary(xml)).pass).toBe(false);
    const compile = parseJunitSummary(toJunit(parseCargoTest(COMPILE_ERROR, { exitCode: 101 })));
    expect(compile).toEqual({ tests: 1, failures: 0, errors: 1, skipped: 0 });
    expect(junitGate(compile).pass).toBe(false);
  });

  test('沒有任何測試：tests 為 0，QA 關卡未通過', () => {
    const summary = parseJunitSummary(toJunit({ suites: [] }));
    expect(summary).toEqual({ tests: 0, failures: 0, errors: 0, skipped: 0 });
    expect(junitGate(summary).pass).toBe(false);
  });
});

describe('CLI', () => {
  const quiet = { log: () => {}, error: () => {} };
  test('--log／--out／--exit：寫入 JUnit 並以 0 結束', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-cj-'));
    try {
      writeFileSync(join(dir, 'cargo-test.log'), COMPILE_ERROR);
      const out = join(dir, 'nested', 'junit.xml');
      const logs = [];
      expect(main(['--log', join(dir, 'cargo-test.log'), '--out', out, '--exit', '101'], { log: (m) => logs.push(m), error: () => {} })).toBe(0);
      expect(parseJunitSummary(readFileSync(out, 'utf8'))).toEqual({ tests: 1, failures: 0, errors: 1, skipped: 0 });
      expect(JSON.parse(logs[0])).toEqual({ suites: 1, tests: 1, failures: 0, errors: 1, skipped: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('參數無效或檔案無法讀取時以 2 結束', () => {
    expect(main([], quiet)).toBe(2);
    expect(main(['--log', 'x.log'], quiet)).toBe(2);
    expect(main(['--log', 'x.log', '--out', 'y.xml', '--exit', 'abc'], quiet)).toBe(2);
    expect(main(['--log', 'x.log', '--out', 'y.xml', '--bogus', '1'], quiet)).toBe(2);
    expect(main(['--log', join(tmpdir(), 'lm-cj-missing', 'none.log'), '--out', join(tmpdir(), 'lm-cj-missing.xml')], quiet)).toBe(2);
  });
});
