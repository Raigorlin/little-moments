// Feature: jenkins-cicd-deploy, Property 30: 遷移集合驗證
// **Validates: Requirements 12.7**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  loadMigrations,
  planMigrations,
  runMigrations,
  MigrationValidationError,
  EXIT_INVALID,
  MAX_MIGRATION_VERSION,
} from '../server/db/migrations.js';

const RUNS = { numRuns: 150 };
const asc = (a, b) => a - b;
const uniqSorted = values => [...new Set(values)].sort(asc);

const nameSuffix = fc.stringMatching(/^[a-z0-9_]{1,12}$/);
const pad = (version, width) => String(version).padStart(width, '0');
// 版本號以 4..8 位數表示；不同位數（例如 0001 與 00001）代表同一版本。
const widthArb = fc.integer({ min: 4, max: 8 });

const fileFor = (version, width, suffix) => ({
  name: `${pad(version, width)}_${suffix}.sql`,
  content: `-- migration ${version} ${suffix}\nSELECT 1;\n`,
});

// 不符合 NNNN_name.sql 規則、但副檔名為 .sql 的檔名。
const badNameArb = fc.oneof(
  fc.integer({ min: 0, max: 999 }).map(v => `${v}_short.sql`),          // 少於 4 位數
  fc.integer({ min: 1, max: 9999 }).map(v => `${pad(v, 4)}-dash.sql`),
  fc.integer({ min: 1, max: 9999 }).map(v => `${pad(v, 4)}_Upper.sql`),
  fc.integer({ min: 1, max: 9999 }).map(v => `${pad(v, 4)}_.sql`),
  fc.constantFrom('abc.sql', 'initial.sql', '_0001_x.sql', 'v0001_x.sql'),
);

const scenarioArb = fc.record({
  valid: fc.uniqueArray(
    fc.record({ version: fc.integer({ min: 1, max: 99_999 }), width: widthArb, suffix: nameSuffix }),
    { selector: r => r.version, maxLength: 15 },
  ),
  dupPicks: fc.array(fc.record({ pick: fc.nat(), width: widthArb, suffix: nameSuffix }), { maxLength: 3 }),
  zeroFiles: fc.array(fc.record({ width: widthArb, suffix: nameSuffix }), { maxLength: 2 }),
  oversize: fc.uniqueArray(fc.integer({ min: MAX_MIGRATION_VERSION + 1, max: 999_999_999_999 }), { maxLength: 2 }),
  badNames: fc.uniqueArray(badNameArb, { maxLength: 3 }),
  ignored: fc.uniqueArray(fc.constantFrom('README.md', '0002_notes.txt', 'schema.sql.bak'), { maxLength: 2 }),
  seed: fc.integer(),
}).map(s => {
  const files = s.valid.map(v => fileFor(v.version, v.width, v.suffix));
  const dupVersions = [];
  if (s.valid.length) {
    for (const d of s.dupPicks) {
      const version = s.valid[d.pick % s.valid.length].version;
      dupVersions.push(version);
      files.push(fileFor(version, d.width, `dup_${d.suffix}`));
    }
  }
  const zeroNames = s.zeroFiles.map(z => `${pad(0, z.width)}_${z.suffix}.sql`);
  for (const name of zeroNames) files.push({ name, content: 'SELECT 0;' });
  const oversizeNames = s.oversize.map(v => `${v}_big.sql`);
  for (const name of oversizeNames) files.push({ name, content: 'SELECT 2;' });
  for (const name of s.badNames) files.push({ name, content: 'SELECT 3;' });
  for (const name of s.ignored) files.push({ name, content: 'not a migration' });
  // 檔案順序隨機（確定性打亂）。
  const keyed = files.map((f, i) => ({ f, k: ((i + 1) * 2654435761 + s.seed) % 1009 }));
  keyed.sort((a, b) => a.k - b.k);

  const expectedVersions = uniqSorted([
    ...dupVersions,
    ...(zeroNames.length ? [0] : []),
    ...s.oversize,
  ]);
  const expectedBadFiles = [...zeroNames, ...oversizeNames, ...s.badNames].sort();
  return {
    files: keyed.map(x => x.f),
    validVersions: s.valid.map(v => v.version).sort(asc),
    expectedVersions,
    expectedBadFiles,
    invalid: expectedVersions.length > 0 || expectedBadFiles.length > 0,
  };
});

describe('Property 30: 遷移集合驗證（loadMigrations）', () => {
  test('有問題時恰好回報有問題的版本號與檔名，否則回傳遞增的有效清單', () => {
    fc.assert(fc.property(scenarioArb, ({ files, validVersions, expectedVersions, expectedBadFiles, invalid }) => {
      let result;
      let error;
      try { result = loadMigrations(files); } catch (e) { error = e; }

      if (!invalid) {
        expect(error).toBeUndefined();
        expect(result.map(m => m.version)).toEqual(validVersions);
        return;
      }
      expect(error).toBeInstanceOf(MigrationValidationError);
      expect(error.versions).toEqual(expectedVersions);
      expect([...error.files].sort()).toEqual(expectedBadFiles);
      for (const v of expectedVersions) expect(error.message).toContain(String(v));
    }), RUNS);
  });

  test('範例：0001 與 00001 視為重複版本', () => {
    let error;
    try {
      loadMigrations([
        { name: '0001_initial.sql', content: 'SELECT 1;' },
        { name: '00001_again.sql', content: 'SELECT 1;' },
        { name: '0002_next.sql', content: 'SELECT 2;' },
      ]);
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(MigrationValidationError);
    expect(error.versions).toEqual([1]);
  });

  test('範例：版本 0 與超出 INTEGER 範圍視為非正整數', () => {
    expect(() => loadMigrations([{ name: '0000_zero.sql', content: '' }])).toThrow(MigrationValidationError);
    expect(() => loadMigrations([{ name: '2147483648_big.sql', content: '' }])).toThrow(MigrationValidationError);
    expect(loadMigrations([{ name: '2147483647_max.sql', content: '' }]).map(m => m.version)).toEqual([2147483647]);
  });
});

// checksum 不符情境：repo 為有效遷移；紀錄為 repo 子集合（部分 checksum 被竄改）加上未知較新版本。
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

const mismatchArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 20 })
  .chain(versions => fc.record({
    repo: fc.array(hex64, { minLength: versions.length, maxLength: versions.length })
      .map(sums => versions.map((version, i) => ({
        version,
        name: `${pad(version, 4)}_m.sql`,
        sql: `-- migration ${version}`,
        checksum: sums[i],
        destructive: false,
      }))),
    appliedFlags: fc.array(fc.constantFrom('absent', 'same', 'tampered'), { minLength: versions.length, maxLength: versions.length }),
    unknown: fc.uniqueArray(fc.integer({ min: 100_001, max: MAX_MIGRATION_VERSION }), { maxLength: 3 }),
    asString: fc.boolean(),
  }))
  .filter(({ appliedFlags }) => appliedFlags.includes('tampered'))
  .map(({ repo, appliedFlags, unknown, asString }) => {
    const applied = [];
    const tampered = [];
    repo.forEach((m, i) => {
      if (appliedFlags[i] === 'absent') return;
      // 竄改：反轉最後一個字元，保證與 repo checksum 不同。
      const checksum = appliedFlags[i] === 'tampered'
        ? m.checksum.slice(0, -1) + (m.checksum.endsWith('0') ? '1' : '0')
        : m.checksum;
      if (appliedFlags[i] === 'tampered') tampered.push(m.version);
      applied.push({ version: m.version, checksum });
    });
    for (const v of unknown) applied.push({ version: v, checksum: 'f'.repeat(64) });
    const rows = applied.map(r => ({ ...r, version: asString ? String(r.version) : r.version }));
    return { repo, applied: rows, tampered: tampered.sort(asc) };
  });

describe('Property 30: 遷移集合驗證（planMigrations checksumMismatch）', () => {
  test('checksumMismatch 恰為已套用但內容摘要不同的版本', () => {
    fc.assert(fc.property(mismatchArb, ({ repo, applied, tampered }) => {
      expect(planMigrations(repo, applied).checksumMismatch).toEqual(tampered);
    }), RUNS);
  });
});

// 記憶體內假 executor：記錄所有可能修改 Database 的動作。
function createFakeSql(initialRows) {
  const state = { rows: initialRows.map(r => ({ ...r })), mutations: [], transactions: 0 };
  const fn = (strings, ...values) => {
    const text = strings.join('?');
    if (/pg_advisory_(un)?lock/.test(text)) return Promise.resolve([]);
    if (/SELECT version, checksum FROM schema_migrations/.test(text)) {
      return Promise.resolve(state.rows.map(r => ({ version: r.version, checksum: r.checksum })));
    }
    state.mutations.push({ text, values });
    return Promise.resolve([]);
  };
  fn.unsafe = text => {
    // 建表為 IF NOT EXISTS，對既有 schema_migrations 不產生變更。
    if (!/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(text)) state.mutations.push({ text });
    return Promise.resolve([]);
  };
  fn.begin = async cb => {
    state.transactions += 1;
    await cb(fn);
  };
  return { sql: fn, state };
}

describe('Property 30: 遷移集合驗證（runMigrations 遇 checksum 不符）', () => {
  test('結束碼 3、不套用任何遷移、不修改 Database，並輸出有問題的版本號', async () => {
    await fc.assert(fc.asyncProperty(mismatchArb, async ({ repo, applied, tampered }) => {
      const { sql, state } = createFakeSql(applied);
      const before = JSON.parse(JSON.stringify(state.rows));
      const logs = [];

      const result = await runMigrations(sql, repo, { log: line => logs.push(line) });

      expect(result.exitCode).toBe(EXIT_INVALID);
      expect(result.applied).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.checksumMismatch).toEqual(tampered);
      expect(state.mutations).toEqual([]);
      expect(state.transactions).toBe(0);
      expect(state.rows).toEqual(before);
      const output = logs.join('\n');
      for (const v of tampered) expect(output).toContain(String(v));
    }), { numRuns: 100 });
  });
});
