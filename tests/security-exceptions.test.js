// security/exceptions.json 的 libc6 例外（Req 6.5、6.6、6.9；build #12 的 Image Scan）。
// 只豁免 oven/bun:1.4.4-distroless 的 libc6 上這 9 個 CVE；其他套件、其他 CVE 與秘密仍然阻擋。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateFindings, parseExceptionsDocument, validateException } from '../ci/policy/evaluate.mjs';

const doc = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'security/exceptions.json'), 'utf8'));
const exceptions = parseExceptionsDocument(doc);
const LIBC6 = ['CVE-2026-84243', 'CVE-2026-86805', 'CVE-2026-95818', 'CVE-2026-100290', 'CVE-2026-115819',
  'CVE-2018-20796', 'CVE-2019-1010022', 'CVE-2019-1010023', 'CVE-2019-9192'];
const finding = (id, location = 'libc6', severity = 'high', kind = 'vulnerability') => ({ scanner: 'trivy', kind, id, location, severity });

describe('security/exceptions.json：libc6 例外', () => {
  test('恰為 9 個欄位完整的例外，location 皆為 libc6、核准人 jacklin、到期日 2027-11-14', () => {
    expect(exceptions.map((e) => e.id).sort()).toEqual([...LIBC6].sort());
    for (const e of exceptions) {
      expect(validateException(e)).toEqual([]);
      expect(e).toMatchObject({ location: 'libc6', approver: 'jacklin', expires: '2027-11-14' });
      expect(e.reason).toContain('libc6');
    }
  });

  test('到期日前：這 9 個 libc6 結果不阻擋；其他 CVE、其他套件與秘密仍阻擋', () => {
    const findings = [...LIBC6.map((id) => finding(id)), finding('CVE-2099-0001'), finding('CVE-2026-84243', 'libssl3'),
      { scanner: 'gitleaks', kind: 'secret', id: 'CVE-2026-84243', location: 'libc6', severity: 'high' }];
    const r = evaluateFindings(findings, exceptions, '2027-11-14');
    expect(r.pass).toBe(false);
    expect(r.unresolved.map((u) => `${u.kind}:${u.id}@${u.location}`).sort()).toEqual([
      'secret:CVE-2026-84243@libc6', 'vulnerability:CVE-2026-84243@libssl3', 'vulnerability:CVE-2099-0001@libc6']);
    expect(evaluateFindings(LIBC6.map((id) => finding(id, 'libc6', 'critical')), exceptions, '2026-11-14').pass).toBe(true);
  });

  test('到期日後：例外列為過期，全部重新阻擋', () => {
    const r = evaluateFindings(LIBC6.map((id) => finding(id)), exceptions, '2027-11-15');
    expect(r.pass).toBe(false);
    expect(r.unresolved).toHaveLength(9);
    expect(r.expired).toHaveLength(9);
  });
});