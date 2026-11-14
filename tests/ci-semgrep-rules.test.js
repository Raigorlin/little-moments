// Semgrep 規則的路徑排除檢查（Req 6.3、6.5、6.7；Design §27.4、§27.6；任務 29.3）。
// CI 的掃描輸入沒有 .git，ci/semgrep/run.sh 以 --project-root . 讓 project root 固定為 repository 根目錄，
// 規則的 paths.exclude 一律使用 Semgrepignore v2 的 anchored 寫法（開頭 `/`），並只能是已審查的清單。
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const rulesDir = join(root, 'ci', 'semgrep', 'rules');

// 已審查的例外（新增需經 code review，並同步更新規則檔註解與此清單）。
const REVIEWED_EXCLUDES = {
  'lm-js-tls-verify-disabled': ['/server/db/connect.js'],
  'lm-js-timing-unsafe-compare': ['/src/'],
  'lm-sql-unsafe': ['/server/db/migrations.js', '/tests/support/pg.js'],
};

const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith('.yaml')).sort();
const rules = ruleFiles.flatMap((file) => {
  const doc = Bun.YAML.parse(readFileSync(join(rulesDir, file), 'utf8'));
  return (doc?.rules ?? []).map((rule) => ({ file, rule }));
});

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const probe = git('rev-parse', '--is-inside-work-tree');
const inGitCheckout = !probe.error && probe.status === 0 && probe.stdout.trim() === 'true';

describe('Semgrep 規則的 paths 樣式（Design §27.4）', () => {
  test('規則檔可解析且每條規則都有 id', () => {
    expect(ruleFiles.length).toBeGreaterThan(0);
    expect(rules.length).toBeGreaterThan(0);
    for (const { rule } of rules) expect(typeof rule.id).toBe('string');
  });

  test('paths.exclude 恰為已審查的清單（規則與項目都相同）', () => {
    const actual = {};
    for (const { rule } of rules) {
      if (rule.paths?.exclude !== undefined) actual[rule.id] = rule.paths.exclude;
    }
    expect(actual).toEqual(REVIEWED_EXCLUDES);
  });

  test('所有 paths.exclude／paths.include 都是 anchored（開頭 `/`）', () => {
    for (const { file, rule } of rules) {
      for (const key of ['exclude', 'include']) {
        for (const pattern of rule.paths?.[key] ?? []) {
          expect(typeof pattern).toBe('string');
          if (!pattern.startsWith('/')) throw new Error(`${file} ${rule.id} paths.${key}: ${pattern} 不是 anchored`);
          expect(pattern.startsWith('//')).toBe(false);
          expect(pattern).not.toContain('*');
          expect(pattern).not.toContain('..');
        }
      }
    }
  });

  test('每個排除項目都指向存在的檔案或目錄（以 `/` 結尾者為目錄）', () => {
    for (const patterns of Object.values(REVIEWED_EXCLUDES)) {
      for (const pattern of patterns) {
        const rel = pattern.slice(1).replace(/\/$/, '');
        const abs = join(root, rel);
        expect(existsSync(abs)).toBe(true);
        expect(statSync(abs).isDirectory()).toBe(pattern.endsWith('/'));
      }
    }
  });

  test.skipIf(!inGitCheckout)('每個排除項目都受版本控制（需要 git checkout）', () => {
    for (const patterns of Object.values(REVIEWED_EXCLUDES)) {
      for (const pattern of patterns) {
        const rel = pattern.slice(1);
        const out = git('ls-files', '--', rel);
        expect(out.status).toBe(0);
        const tracked = out.stdout.split('\n').filter(Boolean);
        if (pattern.endsWith('/')) expect(tracked.length).toBeGreaterThan(0);
        else expect(tracked).toEqual([rel]);
      }
    }
  });
});

describe('ci/semgrep/run.sh 的 scan 指令', () => {
  const runSh = readFileSync(join(root, 'ci', 'semgrep', 'run.sh'), 'utf8');
  const scan = runSh.slice(runSh.indexOf('exec semgrep scan'), runSh.indexOf(';;'));

  test('以 --project-root . 固定 project root，scan root 與其他選項不變', () => {
    expect(scan).toContain('exec semgrep scan');
    const lines = scan.split('\n').map((l) => l.trim().replace(/\s*\\$/, '')).filter(Boolean);
    expect(lines).toContain('--project-root .');
    expect(lines).toContain('--config ci/semgrep/rules');
    expect(lines).toContain('--metrics=off');
    expect(lines).toContain('--disable-version-check');
    expect(lines).toContain("--include '*.js' --include '*.mjs'");
    expect(lines).toContain('--json --output "$out"');
    expect(lines.at(-1)).toBe('src server scripts');
  });

  test('run.sh 維持 LF 行尾', () => {
    expect(runSh.includes('\r')).toBe(false);
  });
});
