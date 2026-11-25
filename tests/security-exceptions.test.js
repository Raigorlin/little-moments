// security/exceptions.json 的例外（Req 6.5、6.6、6.9）：
// - libc6（build #12 的 Image Scan）：只豁免 oven/bun:1.4.4-distroless 的 libc6 上這 12 個 CVE；其他套件、其他 CVE 與秘密仍然阻擋。
// - paste 1.0.15（Security Scan 的 Cargo.lock）：只豁免 RUSTSEC-2024-0436 在 paste 1.0.15 上的結果，到 2027-02-28。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateFindings, parseExceptionsDocument, validateException } from '../ci/policy/evaluate.mjs';

const doc = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'security/exceptions.json'), 'utf8'));
const exceptions = parseExceptionsDocument(doc);
const libc6Exceptions = exceptions.filter((e) => e.location === 'libc6');
const LIBC6 = ['CVE-2026-84243', 'CVE-2026-86805', 'CVE-2026-95818', 'CVE-2026-100290', 'CVE-2026-115819',
  'CVE-2018-20796', 'CVE-2019-1010022', 'CVE-2019-1010023', 'CVE-2019-9192',
  // build release/main #25：glibc iconv 越界讀取，Debian 各版本皆尚無修正。
  'CVE-2026-121757', 'CVE-2026-121758', 'CVE-2026-124024'];
const finding = (id, location = 'libc6', severity = 'high', kind = 'vulnerability') => ({ scanner: 'trivy', kind, id, location, severity });

describe('security/exceptions.json：libc6 例外', () => {
  test('恰為 12 個欄位完整的例外，location 皆為 libc6、核准人 jacklin、到期日 2027-11-14', () => {
    expect(libc6Exceptions.map((e) => e.id).sort()).toEqual([...LIBC6].sort());
    for (const e of libc6Exceptions) {
      expect(validateException(e)).toEqual([]);
      expect(e).toMatchObject({ location: 'libc6', approver: 'jacklin', expires: '2027-11-14' });
      expect(e.reason).toContain('libc6');
    }
  });

  test('到期日前：這 12 個 libc6 結果不阻擋；其他 CVE、其他套件與秘密仍阻擋', () => {
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
    expect(r.unresolved).toHaveLength(LIBC6.length);
    expect(r.expired.filter((e) => e.location === 'libc6')).toHaveLength(LIBC6.length);
  });
});

describe('security/exceptions.json：Cargo.lock 的 paste 例外', () => {
  const paste = (version = '1.0.15', id = 'RUSTSEC-2024-0436') =>
    ({ scanner: 'osv-scanner', kind: 'vulnerability', id, location: 'paste', version, severity: 'unknown' });

  test('只有 libc6 與 paste 兩種例外；paste 只有一筆，限定版本 1.0.15、核准人 Raigorlin、到期日 2027-02-28', () => {
    expect(exceptions.length).toBe(LIBC6.length + 1);
    const entries = exceptions.filter((e) => e.location === 'paste');
    expect(entries).toHaveLength(1);
    expect(validateException(entries[0])).toEqual([]);
    expect(entries[0]).toMatchObject({ id: 'RUSTSEC-2024-0436', version: '1.0.15', approver: 'Raigorlin', expires: '2027-02-28' });
    expect(entries[0].reason).toContain('Leptos 0.8.23');
  });

  test('到期日當日仍不阻擋；隔天、其他版本或其他 advisory 都阻擋', () => {
    expect(evaluateFindings([paste()], exceptions, '2027-02-28').pass).toBe(true);
    const next = evaluateFindings([paste()], exceptions, '2027-03-01');
    expect(next.pass).toBe(false);
    expect(next.unresolved[0].reason).toBe('exception-expired');
    for (const f of [paste('1.0.16'), paste('1.0.14'), paste('1.0.15', 'RUSTSEC-2099-0001')]) {
      const r = evaluateFindings([f], exceptions, '2026-11-25');
      expect(r.pass).toBe(false);
      expect(r.unresolved[0].reason).toBe('no-exception');
    }
  });
});