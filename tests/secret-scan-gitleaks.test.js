import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ASSETS, GITLEAKS_VERSION, SCANNER_CONFIG_FILES, parseHistoryBase, verifySha256 } from '../scripts/gitleaks-check.mjs';

// scripts/gitleaks-check.mjs 的純函式與釘選值（不連網、不執行 Gitleaks）。
const jenkinsfile = readFileSync(join(import.meta.dir, '..', 'Jenkinsfile'), 'utf8');

describe('scripts/gitleaks-check.mjs', () => {
  test('版本與 Jenkinsfile 的 Gitleaks 映像相同，資產以 64 位小寫 hex 的 SHA-256 釘選', () => {
    expect(jenkinsfile).toContain(`ghcr.io/gitleaks/gitleaks:v${GITLEAKS_VERSION}`);
    expect(Object.keys(ASSETS).sort()).toEqual(['linux', 'win32']);
    for (const a of Object.values(ASSETS)) {
      expect(a.name).toContain(`_${GITLEAKS_VERSION}_`);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('刪除的掃描器設定檔與 Jenkinsfile「export scan sources」相同', () => {
    const m = /for f in ([^;]+); do\s*\n\s*rm -f "\$LM_SCAN_DIR\/tree\/\$f"/.exec(jenkinsfile);
    expect(m).not.toBeNull();
    expect(SCANNER_CONFIG_FILES).toEqual(m[1].trim().split(/\s+/));
  });

  test('parseHistoryBase 取出 Jenkinsfile 的常數，拒絕缺少、重複或格式不符', () => {
    const floor = /LM_GITLEAKS_HISTORY_BASE\s*=\s*'([^']+)'/.exec(jenkinsfile)[1];
    expect(parseHistoryBase(jenkinsfile)).toBe(floor);
    const line = (v) => `    LM_GITLEAKS_HISTORY_BASE = '${v}'\n`;
    const sha = 'a'.repeat(40);
    expect(parseHistoryBase(line(sha))).toBe(sha);
    expect(parseHistoryBase('')).toBeNull();
    expect(parseHistoryBase(line(sha) + line(sha))).toBeNull();
    expect(parseHistoryBase(line('a'.repeat(39)))).toBeNull();
    expect(parseHistoryBase(line('A'.repeat(40)))).toBeNull();
  });

  test('verifySha256 只接受相符的摘要', () => {
    const buf = Buffer.from('lm');
    const digest = createHash('sha256').update(buf).digest('hex');
    expect(verifySha256(buf, digest)).toBe(true);
    expect(verifySha256(buf, '0'.repeat(64))).toBe(false);
  });
});
