// ci/rust-toolchain.json、根目錄 Dockerfile 的 toolchain 階段與 ci/verify-rust-toolchain.sh 一致（plan.md D3）。
// Dockerfile 只以讀檔檢查；verify-rust-toolchain.sh 在有 sh 的環境以假的工具執行（Windows 上略過）。
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const expected = JSON.parse(read('ci/rust-toolchain.json'));
const dockerfile = read('Dockerfile');
const arg = (name) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1];

/** Cargo.lock 中某個套件的版本（只有一個版本時）。 */
function lockVersions(name) {
  const lock = read('Cargo.lock').replace(/\r\n/g, '\n');
  return [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
    .filter((m) => m[1] === name).map((m) => m[2]);
}

describe('ci/rust-toolchain.json 與 Dockerfile', () => {
  test('列出六項工具，值只含數字與點', () => {
    const { _comment, ...versions } = expected;
    expect(typeof _comment).toBe('string');
    expect(Object.keys(versions).sort()).toEqual(['bats', 'rust', 'trunk', 'wasm-bindgen', 'wasm-opt']);
    for (const v of Object.values(versions)) expect(v).toMatch(/^\d+(\.\d+)*$/);
  });

  test('rust：toolchain 階段的映像標籤與 RUSTUP_TOOLCHAIN', () => {
    const from = /^FROM rust:(\S+)-trixie@sha256:[0-9a-f]{64} AS toolchain$/m.exec(dockerfile);
    expect(from?.[1]).toBe(expected.rust);
    expect(/RUSTUP_TOOLCHAIN=(\S+)/.exec(dockerfile)?.[1]).toBe(expected.rust);
  });

  test('trunk、wasm-bindgen、binaryen、bats：Dockerfile 的 ARG，每個下載都有 SHA-256', () => {
    expect(arg('TRUNK_VERSION')).toBe(expected.trunk);
    expect(arg('WASM_BINDGEN_VERSION')).toBe(expected['wasm-bindgen']);
    expect(arg('BINARYEN_VERSION')).toBe(expected['wasm-opt']);
    expect(arg('BATS_VERSION')).toBe(expected.bats);
    for (const name of ['TRUNK', 'WASM_BINDGEN', 'BINARYEN', 'BATS']) {
      expect(arg(`${name}_SHA256`)).toMatch(/^[0-9a-f]{64}$/);
      expect(dockerfile).toContain(`echo "\${${name}_SHA256}  $tmp/`);
    }
    expect(dockerfile.match(/sha256sum -c -/g)?.length).toBe(4);
    expect(dockerfile.match(/curl -fsSL -o /g)?.length).toBe(4);
  });

  test('wasm-bindgen 與 Cargo.lock 相同（trunk 需要相同版本的 CLI）', () => {
    expect(lockVersions('wasm-bindgen')).toEqual([expected['wasm-bindgen']]);
  });

  test('toolchain 階段不複製 repository 內容', () => {
    const toolchain = dockerfile.split(/^FROM /m).find((s) => / AS toolchain\n/.test(s));
    expect(toolchain).toBeDefined();
    expect(toolchain).not.toMatch(/^(COPY|ADD) /m);
  });
});

// Windows 的 sh（Git for Windows）不接受以 : 分隔的 PATH，因此只在 POSIX 系統上執行。
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasSh)('ci/verify-rust-toolchain.sh', () => {
  const FAKE = {
    rustc: 'rustc 1.100.0 (0ef1bc386 2026-11-09)',
    cargo: 'cargo 1.100.0 (3acc79c0c 2026-11-05)',
    trunk: 'trunk 0.22.2',
    'wasm-bindgen': 'wasm-bindgen 0.2.130',
    'wasm-opt': 'wasm-opt version 131 (version_131)',
    bats: 'Bats 1.14.0',
  };
  function run(overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lm-rtc-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      for (const [tool, out] of Object.entries({ ...FAKE, ...overrides })) {
        if (out === null) continue;
        const file = join(bin, tool);
        writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${out}'\n`);
        chmodSync(file, 0o755);
      }
      const out = join(dir, 'reports', 'rust-toolchain.json');
      const r = spawnSync('sh', ['ci/verify-rust-toolchain.sh', '--out', out], {
        cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` },
      });
      return { status: r.status, report: JSON.parse(readFileSync(out, 'utf8')), stderr: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('全部一致時結束碼 0，報告逐項列出預期與實際', () => {
    const { status, report } = run();
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.tools.map((t) => [t.tool, t.expected, t.actual, t.ok])).toEqual([
      ['rustc', '1.100.0', '1.100.0', true], ['cargo', '1.100.0', '1.100.0', true], ['trunk', '0.22.2', '0.22.2', true],
      ['wasm-bindgen', '0.2.130', '0.2.130', true], ['wasm-opt', '131', '131', true], ['bats', '1.14.0', '1.14.0', true],
    ]);
  });

  test('版本不同、工具缺少或輸出無法辨識時結束碼 1', () => {
    const r = run({ trunk: 'trunk 0.22.3', bats: null, 'wasm-opt': 'something else' });
    expect(r.status).toBe(1);
    expect(r.report.ok).toBe(false);
    const byTool = Object.fromEntries(r.report.tools.map((t) => [t.tool, t]));
    expect(byTool.trunk).toMatchObject({ actual: '0.22.3', ok: false });
    expect(byTool.bats).toMatchObject({ actual: null, ok: false });
    expect(byTool['wasm-opt']).toMatchObject({ actual: null, ok: false });
    expect(byTool.rustc.ok).toBe(true);
  });

  test('未知參數或無法讀取 --expected 時結束碼 2', () => {
    expect(spawnSync('sh', ['ci/verify-rust-toolchain.sh', '--nope'], { cwd: root }).status).toBe(2);
    expect(spawnSync('sh', ['ci/verify-rust-toolchain.sh', '--expected', '/nonexistent/x.json'], { cwd: root }).status).toBe(2);
  });
});

describe('ci/verify-rust-toolchain.sh（靜態檢查）', () => {
  const script = read('ci/verify-rust-toolchain.sh');
  test('POSIX sh、LF 換行、嚴格模式', () => {
    expect(script).not.toContain('\r');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('set -eu');
    for (const tool of ['rustc', 'cargo', 'trunk', 'wasm-bindgen', 'wasm-opt', 'bats']) expect(script).toContain(`${tool})`);
  });
});
