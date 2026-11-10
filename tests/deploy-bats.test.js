// deploy/tests/lm-deploy.bats 的 bun 包裝（tasks.md 14.4）。
// 只在非 Windows 且 PATH 上有 bats 時執行（Deploy_Host／Linux Build_Agent）；否則跳過，bun 套件不依賴 WSL 或 bats。
// 另以靜態檢查確認 bats 測試與假 docker 以 LF 提交（CR 會讓 bash 執行失敗）。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FILES = ['deploy/tests/lm-deploy.bats', 'deploy/tests/helpers/fake-docker', 'deploy/tests/helpers/test_helper.bash'];
const bats = process.platform === 'win32' ? null : Bun.which('bats');

describe('deploy/tests (bats)', () => {
  test('bats 測試檔與 helper 不含 CR', () => {
    for (const f of FILES) expect(readFileSync(join(ROOT, f), 'utf8').includes('\r')).toBe(false);
  });

  test.skipIf(!bats)('lm-deploy.bats 全部通過', () => {
    const r = Bun.spawnSync([bats, '--tap', 'deploy/tests/lm-deploy.bats'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const out = r.stdout.toString() + r.stderr.toString();
    if (r.exitCode !== 0) console.error(out);
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
