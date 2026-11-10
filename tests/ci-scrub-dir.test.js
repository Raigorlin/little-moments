// ci/scrub.mjs 的 --secrets-dir（Jenkinsfile 收尾 post { always } 使用；Req 15.4、21.9）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MASK, findLeaks, loadSecretsDir, main, rawSecretEntries } from '../ci/scrub.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lm-scrub-dir-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function secretDir(files) {
  const dir = join(root, 'secrets');
  mkdirSync(dir, { mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(join(dir, name), 0o600);
  }
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  return dir;
}

describe('rawSecretEntries', () => {
  test('原值檔：移除結尾換行，ID 為檔名', () => {
    expect(rawSecretEntries('cred-lm-prod-db', 'p@ss word%2F\n')).toEqual([{ id: 'cred-lm-prod-db', value: 'p@ss word%2F' }]);
    expect(rawSecretEntries('cred-x', 'abc\r\n\r\n')).toEqual([{ id: 'cred-x', value: 'abc' }]);
    expect(rawSecretEntries('cred-empty', '\n')).toEqual([]);
  });

  test('多行值另將每一行（≥ 16 字元，PEM 標頭除外）列為秘密', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nshort\n-----END OPENSSH PRIVATE KEY-----\n';
    const entries = rawSecretEntries('cred-lm-ssh-prod', pem);
    expect(entries[0]).toEqual({ id: 'cred-lm-ssh-prod', value: pem.replace(/\n$/, '') });
    expect(entries.slice(1)).toEqual([{ id: 'cred-lm-ssh-prod#2', value: 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ' }]);
  });
});

describe('loadSecretsDir', () => {
  test('合併原值檔與 JSON 檔（各階段 Ephemeral_Database 的 scrub-secrets.json 副本）', () => {
    const dir = secretDir({
      'cred-lm-registry-pull': 'pull-password-123\n',
      'lm-edb-unit-0123456789abcdef.json': JSON.stringify({ 'lm-ephemeral-db': 'a'.repeat(48) }),
    });
    const r = loadSecretsDir(dir);
    expect(r.ok).toBe(true);
    expect(r.secrets).toEqual([
      { id: 'cred-lm-registry-pull', value: 'pull-password-123' },
      { id: 'lm-ephemeral-db', value: 'a'.repeat(48) },
    ]);
  });

  test('目錄不存在、檔名無效、子目錄或 JSON 無效時失敗，訊息不含內容', () => {
    expect(loadSecretsDir(join(root, 'missing')).ok).toBe(false);
    const dir = secretDir({ 'bad name': 'secret-value-000' });
    const bad = loadSecretsDir(dir);
    expect(bad).toEqual({ ok: false, reason: '秘密目錄含無效的檔名' });
    rmSync(dir, { recursive: true });
    const dir2 = secretDir({ 'x.json': '{not json' });
    expect(loadSecretsDir(dir2)).toEqual({ ok: false, reason: '秘密目錄中的 JSON 檔無效' });
    rmSync(dir2, { recursive: true });
    const dir3 = secretDir({});
    mkdirSync(join(dir3, 'sub'));
    expect(loadSecretsDir(dir3)).toEqual({ ok: false, reason: '秘密目錄只能包含一般檔案' });
  });

  test('POSIX 平台拒絕權限過寬的目錄或檔案', () => {
    const dirent = (name) => ({ name, isFile: () => true });
    const fakeFs = (dirMode, fileMode) => ({
      lstatSync: () => ({ isDirectory: () => true, mode: dirMode }),
      readdirSync: () => [dirent('cred-a')],
      statSync: () => ({ mode: fileMode }),
      readFileSync: () => 'value-value-value',
    });
    expect(loadSecretsDir('/d', { fs: fakeFs(0o40755, 0o100600), platform: 'linux' }).reason).toBe('秘密目錄權限過寬（須為 0700）');
    expect(loadSecretsDir('/d', { fs: fakeFs(0o40700, 0o100644), platform: 'linux' }).reason).toBe('秘密檔權限過寬（須為 0600）');
    expect(loadSecretsDir('/d', { fs: fakeFs(0o40700, 0o100600), platform: 'linux' })).toEqual({ ok: true, secrets: [{ id: 'cred-a', value: 'value-value-value' }] });
  });
});

describe('CLI --secrets-dir', () => {
  const quiet = { log: () => {}, error: () => {} };

  test('遮罩 reports/ 的所有檔案至輸出目錄，處理報告只含檔名與憑證 ID', () => {
    const token = 'tok/en+value=with%chars';
    const dir = secretDir({ 'cred-lm-prod-setup-token': token, 'lm-edb-e2e-0000000000000000.json': JSON.stringify({ 'lm-ephemeral-db': 'b'.repeat(48) }) });
    const input = join(root, 'reports');
    mkdirSync(join(input, 'security'), { recursive: true });
    writeFileSync(join(input, 'server.log'), `pw=${'b'.repeat(48)} url=${encodeURIComponent(token)}\n`);
    writeFileSync(join(input, 'security', 'evaluation.json'), '{"pass":true}\n');
    const out = join(root, 'archive', 'reports');
    const report = join(out, 'archive-scrub.json');
    expect(main(['--secrets-dir', dir, '--in', input, '--out', out, '--report', report], quiet)).toBe(0);
    const log = readFileSync(join(out, 'server.log'), 'utf8');
    expect(log).toBe(`pw=${MASK} url=${MASK}\n`);
    expect(findLeaks(log, [{ id: 't', value: token }, { id: 'd', value: 'b'.repeat(48) }])).toEqual([]);
    expect(readFileSync(join(out, 'security', 'evaluation.json'), 'utf8')).toBe('{"pass":true}\n');
    const summary = JSON.parse(readFileSync(report, 'utf8'));
    expect(summary).toMatchObject({ ok: true, files: 2, maskedFiles: 1, withheld: [] });
    expect(readFileSync(report, 'utf8')).not.toContain(token);
  });

  test('可與 --secrets 併用；缺少秘密來源、重複參數或秘密目錄無效時結束碼 2', () => {
    const dir = secretDir({ 'cred-a': 'aaaaaaaaaaaa' });
    const file = join(root, 'extra.json');
    writeFileSync(file, JSON.stringify({ b: 'bbbbbbbbbbbb' }), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    const input = join(root, 'in');
    mkdirSync(input);
    writeFileSync(join(input, 'x.txt'), 'aaaaaaaaaaaa bbbbbbbbbbbb');
    const out = join(root, 'out');
    expect(main(['--secrets', file, '--secrets-dir', dir, '--in', input, '--out', out], quiet)).toBe(0);
    expect(readFileSync(join(out, 'x.txt'), 'utf8')).toBe(`${MASK} ${MASK}`);
    expect(main(['--in', input], quiet)).toBe(2);
    expect(main(['--secrets-dir', dir, '--secrets-dir', dir, '--in', input], quiet)).toBe(2);
    expect(main(['--secrets-dir', join(root, 'nope'), '--in', input, '--out', join(root, 'out2')], quiet)).toBe(2);
    expect(existsSync(join(root, 'out2'))).toBe(false);
  });
});
