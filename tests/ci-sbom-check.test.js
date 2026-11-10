// ci/sbom-check.mjs：Syft CycloneDX SBOM 的格式與套件計數檢查（Image Pipeline 的 SBOM 階段）。
// **Validates: Requirements 17.4**
import { afterAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, purlType, summarizeSbom } from '../ci/sbom-check.mjs';

const sbom = (components) => ({ bomFormat: 'CycloneDX', specVersion: '1.6', components });
const npm = (name, version = '1.0.0') => ({ type: 'library', name, version, purl: `pkg:npm/${name}@${version}` });
const deb = (name) => ({ type: 'library', name, version: '1', purl: `pkg:deb/debian/${name}@1?arch=amd64` });

describe('summarizeSbom', () => {
  test('CycloneDX 含 npm 與作業系統套件時通過，並計數', () => {
    const r = summarizeSbom(sbom([npm('postgres'), deb('libc6'), { type: 'operating-system', name: 'debian' }]));
    expect(r).toMatchObject({ ok: true, reason: null, specVersion: '1.6', components: 3, npm: 1, os: 1, other: 1 });
  });

  test('非 CycloneDX、缺 specVersion、沒有元件、沒有 npm 套件或元件無名稱時不通過（fail closed）', () => {
    expect(summarizeSbom(null).ok).toBe(false);
    expect(summarizeSbom({ spdxVersion: 'SPDX-2.3', packages: [] }).ok).toBe(false);
    expect(summarizeSbom({ bomFormat: 'CycloneDX', components: [npm('a')] }).ok).toBe(false);
    expect(summarizeSbom(sbom([])).ok).toBe(false);
    expect(summarizeSbom(sbom([deb('libc6')])).reason).toContain('npm');
    expect(summarizeSbom(sbom([npm('a'), { name: '' }])).ok).toBe(false);
  });

  test('purlType 只接受 pkg:<type>/ 形式', () => {
    expect(purlType('pkg:npm/%40scope/x@1')).toBe('npm');
    expect(purlType('pkg:DEB/debian/x@1')).toBe('deb');
    expect(purlType('npm/x')).toBeNull();
    expect(purlType(undefined)).toBeNull();
  });

  test('Property：計數加總等於元件數，且通過若且唯若至少一個 npm 套件', () => {
    const component = fc.oneof(
      fc.constantFrom('a', 'left-pad', '@scope/pkg').map((n) => npm(n)),
      fc.constantFrom('libc6', 'tzdata').map(deb),
      fc.constantFrom('debian', 'bun').map((name) => ({ type: 'file', name })),
    );
    fc.assert(fc.property(fc.array(component, { minLength: 1, maxLength: 30 }), (list) => {
      const r = summarizeSbom(sbom(list));
      const expectedNpm = list.filter((c) => c.purl?.startsWith('pkg:npm/')).length;
      expect(r.components).toBe(list.length);
      expect(r.npm + r.os + r.other).toBe(list.length);
      expect(r.npm).toBe(expectedNpm);
      expect(r.ok).toBe(expectedNpm > 0);
    }), { numRuns: 200 });
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-sbom-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, error: () => {} };

  test('通過時寫出只含計數的摘要並回傳 0；SBOM 無法解析時回傳 1；參數錯誤回傳 2', () => {
    const input = join(dir, 'sbom.json');
    const out = join(dir, 'summary.json');
    writeFileSync(input, JSON.stringify(sbom([npm('postgres'), deb('libc6')])));
    const id = `sha256:${'a'.repeat(64)}`;
    expect(main(['--in', input, '--out', out, '--image-id', id], quiet)).toBe(0);
    const summary = JSON.parse(readFileSync(out, 'utf8'));
    expect(summary).toEqual({ ok: true, reason: null, specVersion: '1.6', components: 2, npm: 1, os: 1, other: 0, imageId: id });
    expect(JSON.stringify(summary)).not.toContain('postgres');

    writeFileSync(input, '{not json');
    expect(main(['--in', input, '--out', out], quiet)).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf8')).ok).toBe(false);
    expect(main(['--in', join(dir, 'missing.json'), '--out', out], quiet)).toBe(1);
    expect(main(['--in', input], quiet)).toBe(2);
    expect(main(['--bogus', 'x', '--in', input, '--out', out], quiet)).toBe(2);
  });
});
