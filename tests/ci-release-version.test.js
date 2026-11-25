// ci/release-version.mjs：發行版本取自 Cargo.toml 的 [workspace.package] version（plan.md D2）。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { main, releaseVersion } from '../ci/release-version.mjs';

const root = resolve(import.meta.dir, '..');
const cargoToml = readFileSync(resolve(root, 'Cargo.toml'), 'utf8');

describe('releaseVersion', () => {
  test('目前的 repository 是 v2.0.0', () => {
    expect(releaseVersion(cargoToml)).toBe('v2.0.0');
  });

  test('只讀取 [workspace.package]，不受其他表格的 version 影響；允許行尾註解與 CRLF', () => {
    const text = [
      '[package]', 'version = "9.9.9"', '', '[workspace.package] # 共用設定', 'edition = "2021"',
      'version = "1.2.3" # 發行版本', 'publish = false', '', '[dependencies.foo]', 'version = "0.1"',
    ].join('\r\n');
    expect(releaseVersion(text)).toBe('v1.2.3');
  });

  test.each([
    ['沒有 [workspace.package]', '[workspace]\nmembers = []\n'],
    ['沒有 version', '[workspace.package]\nedition = "2021"\n'],
    ['version 不在 [workspace.package]', '[workspace.package]\nedition = "2021"\n[package]\nversion = "1.0.0"\n'],
    ['預發行版本', '[workspace.package]\nversion = "2.0.0-rc.1"\n'],
    ['兩段版本', '[workspace.package]\nversion = "2.0"\n'],
    ['前置 v', '[workspace.package]\nversion = "v2.0.0"\n'],
    ['不是字串', '[workspace.package]\nversion = 2\n'],
    ['單引號以外的寫法', "[workspace.package]\nversion = { workspace = true }\n"],
    ['重複的 version', '[workspace.package]\nversion = "1.0.0"\nversion = "1.0.1"\n'],
    ['被註解掉', '[workspace.package]\n# version = "1.0.0"\n'],
    ['空白', ''],
  ])('拒絕：%s', (_name, text) => {
    expect(() => releaseVersion(text)).toThrow();
  });
});

describe('CLI', () => {
  test('輸出一行 v<version> 並以 0 結束', () => {
    const out = [];
    expect(main([], { log: (m) => out.push(m), error: () => {}, readFile: () => cargoToml })).toBe(0);
    expect(out).toEqual(['v2.0.0']);
  });

  test('--cargo-toml 讀取指定檔案；格式無效、檔案不存在或參數錯誤時以 1 結束且不輸出版本', () => {
    const out = [], err = [];
    const io = { log: (m) => out.push(m), error: (m) => err.push(m) };
    expect(main(['--cargo-toml', 'x/Cargo.toml'], { ...io, readFile: (p) => (p === 'x/Cargo.toml' ? '[workspace.package]\nversion = "3.1.4"\n' : '') })).toBe(0);
    expect(main(['--cargo-toml', 'bad'], { ...io, readFile: () => '[workspace.package]\nversion = "3.1"\n' })).toBe(1);
    expect(main(['--cargo-toml', resolve(root, 'no-such-dir', 'Cargo.toml')], io)).toBe(1);
    expect(main(['--bogus'], io)).toBe(1);
    expect(out).toEqual(['v3.1.4']);
    expect(err.length).toBe(3);
  });
});
