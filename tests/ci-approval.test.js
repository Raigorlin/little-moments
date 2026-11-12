// Feature: jenkins-cicd-deploy, Property 32: 破壞性遷移核准人限制
// **Validates: Requirements 12.6**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_APPROVERS_FILE,
  destructiveApprovalAllowed,
  isReleaseApprover,
  loadApprovers,
  main,
  migrationAuthors,
  normalizeEmail,
} from '../ci/approval.mjs';

const RUNS = { numRuns: 200 };

// ---------- 產生器 ----------

// ID 由兩個固定池產生，因此「是否有效」由所屬池決定（獨立於實作的正規式）。
const VALID_IDS = ['alice', 'bob', 'carol.ops', 'dave-1', 'e_v@corp', 'Z9', 'x'.repeat(128)];
const INVALID_IDS = ['', ' alice', '-lead', '.dot', 'has space', 'x'.repeat(129), 'a/b', 'émile'];
const validIdArb = fc.constantFrom(...VALID_IDS);
const invalidIdArb = fc.constantFrom(...INVALID_IDS);

const LOCAL_CHARS = 'abcdefgxyzABCXYZ0189._+-'.split('');
const DOMAIN_CHARS = 'abcmnoxyzABC019.-'.split('');
const PAD_CHARS = [' ', '\t', '\n', '\r'];

const baseEmailArb = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...LOCAL_CHARS), minLength: 1, maxLength: 8 }),
    fc.string({ unit: fc.constantFrom(...DOMAIN_CHARS), minLength: 1, maxLength: 8 }),
  )
  .map(([l, d]) => `${l}@${d}`);

const padArb = fc.string({ unit: fc.constantFrom(...PAD_CHARS), maxLength: 2 });

/** 大小寫與前後空白變化（正規化後應與原 email 相同）。 */
function variantArb(email) {
  return fc
    .tuple(padArb, fc.array(fc.boolean(), { minLength: email.length, maxLength: email.length }), padArb)
    .map(([pre, flips, post]) =>
      pre + [...email].map((c, i) => (flips[i] ? c.toUpperCase() : c.toLowerCase())).join('') + post);
}

const INVALID_EMAILS = ['', '   ', 'no-at-sign', 'a@b@c', 'a b@c', '@domain', 'local@', 'x@y z', 'a\t@b'];
const invalidEmailArb = fc.constantFrom(...INVALID_EMAILS);

// ---------- 獨立 oracle ----------

const ORACLE_WS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

function oracleNormalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  if (t.length < 1 || t.length > 254) return null;
  for (const c of t) if (ORACLE_WS.has(c)) return null;
  const at = t.indexOf('@');
  if (at <= 0 || at !== t.lastIndexOf('@') || at === t.length - 1) return null;
  return t;
}

const oracleIdValid = id => VALID_IDS.includes(id);

/** @returns {Map<string, Set<string>> | null} 有效時回傳 jenkinsId → 正規化 email 集合。 */
function oracleLoad(doc) {
  const list = Array.isArray(doc) ? doc : (doc && typeof doc === 'object' ? doc.approvers : undefined);
  if (!Array.isArray(list)) return null;
  const map = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object' || !oracleIdValid(e.jenkinsId)) return null;
    if (map.has(e.jenkinsId)) return null;
    if (!Array.isArray(e.emails) || e.emails.length === 0) return null;
    const set = new Set();
    for (const raw of e.emails) {
      const n = oracleNormalizeEmail(raw);
      if (n === null) return null;
      set.add(n);
    }
    map.set(e.jenkinsId, set);
  }
  return map;
}

function oracleAllowed(approver, doc, authors) {
  const map = oracleLoad(doc);
  if (!map || !map.has(approver)) return false;
  if (!Array.isArray(authors) || authors.length === 0) return false;
  const authorSet = new Set();
  for (const a of authors) {
    const n = oracleNormalizeEmail(a);
    if (n === null) return false;
    authorSet.add(n);
  }
  for (const e of map.get(approver)) if (authorSet.has(e)) return false;
  return true;
}

// ---------- 情境產生器 ----------

const emailEntryArb = fc.oneof(
  { weight: 8, arbitrary: baseEmailArb.chain(variantArb) },
  { weight: 1, arbitrary: invalidEmailArb },
);

const entryArb = fc.oneof(
  {
    weight: 10,
    arbitrary: fc.record({
      jenkinsId: fc.oneof({ weight: 9, arbitrary: validIdArb }, { weight: 1, arbitrary: invalidIdArb }),
      emails: fc.oneof(
        { weight: 9, arbitrary: fc.array(emailEntryArb, { minLength: 1, maxLength: 3 }) },
        { weight: 1, arbitrary: fc.constantFrom([], null, 'a@b') },
      ),
    }),
  },
  { weight: 1, arbitrary: fc.constantFrom(null, 'alice', 42, {}) },
);

// 清單可能含重複 jenkinsId（VALID_IDS 池小，自然會發生）。
const docArb = fc.array(entryArb, { maxLength: 5 }).chain(list =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constant({ schema: 1, approvers: list }) },
    { weight: 3, arbitrary: fc.constant(list) },
    { weight: 1, arbitrary: fc.constantFrom(null, {}, 'x', { approvers: 'nope' }) },
  ));

/** 依文件產生核准人與作者集合，作者常包含核准人 email 的大小寫／空白變體。 */
const scenarioArb = docArb.chain(doc => {
  const list = Array.isArray(doc) ? doc : doc?.approvers;
  const entries = Array.isArray(list) ? list.filter(e => e && typeof e === 'object') : [];
  const ids = entries.map(e => e.jenkinsId).filter(id => typeof id === 'string');
  const approverEmails = entries.flatMap(e => (Array.isArray(e.emails) ? e.emails : []))
    .filter(e => typeof e === 'string' && oracleNormalizeEmail(e) !== null)
    .map(e => e.trim());

  const approverArb = ids.length > 0
    ? fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...ids) }, { weight: 2, arbitrary: validIdArb }, { weight: 1, arbitrary: invalidIdArb })
    : fc.oneof(validIdArb, invalidIdArb);

  const authorItem = approverEmails.length > 0
    ? fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...approverEmails).chain(variantArb) },
      { weight: 5, arbitrary: baseEmailArb },
      { weight: 1, arbitrary: invalidEmailArb },
    )
    : fc.oneof({ weight: 6, arbitrary: baseEmailArb }, { weight: 1, arbitrary: invalidEmailArb });

  const authorsArb = fc.oneof(
    { weight: 10, arbitrary: fc.array(authorItem, { minLength: 1, maxLength: 4 }) },
    { weight: 1, arbitrary: fc.constant([]) },
    { weight: 1, arbitrary: fc.constantFrom(null, undefined, 'a@b') },
  );
  return fc.record({ doc: fc.constant(doc), approver: approverArb, authors: authorsArb });
});

/** 保證有效的清單，核准人必在清單內。 */
const validScenarioArb = fc
  .uniqueArray(validIdArb, { minLength: 1, maxLength: 4 })
  .chain(ids => fc.record({
    ids: fc.constant(ids),
    emails: fc.array(fc.array(baseEmailArb, { minLength: 1, maxLength: 3 }), { minLength: ids.length, maxLength: ids.length }),
    pick: fc.nat({ max: ids.length - 1 }),
  }))
  .map(({ ids, emails, pick }) => ({
    doc: { schema: 1, approvers: ids.map((jenkinsId, i) => ({ jenkinsId, emails: emails[i] })) },
    approver: ids[pick],
    ownEmails: emails[pick],
  }));

// ---------- 純函式屬性 ----------

describe('Property 32: 破壞性遷移核准人限制', () => {
  test('destructiveApprovalAllowed 與 oracle 一致（含無效清單、重複 ID、空作者、無效 email）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, approver, authors }) => {
        const result = destructiveApprovalAllowed(approver, doc, authors);
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.allowed).toBe(oracleAllowed(approver, doc, authors));
      }),
      RUNS,
    );
  });

  test('isReleaseApprover 與 loadApprovers 與 oracle 一致', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, approver }) => {
        const map = oracleLoad(doc);
        expect(isReleaseApprover(approver, doc)).toBe(map !== null && map.has(approver));
        const loaded = loadApprovers(doc);
        expect(loaded.ok).toBe(map !== null);
        if (loaded.ok) {
          expect(loaded.approvers.map(a => a.jenkinsId)).toEqual([...map.keys()]);
          for (const a of loaded.approvers) expect(new Set(a.emails)).toEqual(map.get(a.jenkinsId));
        }
      }),
      RUNS,
    );
  });

  test('有效清單：作者含核准人任一 email 的大小寫／空白變體即拒絕；否則允許', () => {
    fc.assert(
      fc.property(
        validScenarioArb.chain(s => fc.record({
          s: fc.constant(s),
          own: fc.constantFrom(...s.ownEmails).chain(variantArb),
          others: fc.array(baseEmailArb, { maxLength: 3 }),
          include: fc.boolean(),
        })),
        ({ s, own, others, include }) => {
          const ownSet = new Set(s.ownEmails.map(e => e.toLowerCase()));
          const disjoint = others.filter(e => !ownSet.has(e.toLowerCase()));
          const authors = include ? [...disjoint, own] : disjoint;
          const result = destructiveApprovalAllowed(s.approver, s.doc, authors);
          expect(result.allowed).toBe(!include && disjoint.length > 0);
          // 非清單成員一律拒絕
          const outsider = VALID_IDS.find(id => !s.doc.approvers.some(a => a.jenkinsId === id));
          if (outsider) expect(destructiveApprovalAllowed(outsider, s.doc, disjoint).allowed).toBe(false);
        },
      ),
      RUNS,
    );
  });

  test('normalizeEmail 與 oracle 一致', () => {
    fc.assert(
      fc.property(
        fc.oneof(baseEmailArb.chain(variantArb), invalidEmailArb, fc.string({ maxLength: 12 }), fc.constantFrom(null, 1, {})),
        v => {
          expect(normalizeEmail(v)).toBe(oracleNormalizeEmail(v));
        },
      ),
      RUNS,
    );
  });

  // 範例：Jenkins ID 完全相符（大小寫不同不算同一人）
  test('jenkinsId 必須完全相符', () => {
    const doc = { approvers: [{ jenkinsId: 'alice', emails: ['alice@example.invalid'] }] };
    expect(isReleaseApprover('alice', doc)).toBe(true);
    expect(isReleaseApprover('Alice', doc)).toBe(false);
    expect(destructiveApprovalAllowed('Alice', doc, ['bob@example.invalid']).allowed).toBe(false);
    expect(destructiveApprovalAllowed('alice', doc, ['bob@example.invalid']).allowed).toBe(true);
    expect(destructiveApprovalAllowed('alice', doc, [' ALICE@Example.Invalid ']).allowed).toBe(false);
  });
});

// ---------- migrationAuthors（注入假 spawn） ----------

const VALID_MIGRATIONS = ['migrations/0001_initial.sql', 'migrations/0042_add_index.sql', 'migrations/12345_x9.sql'];
const INVALID_MIGRATIONS = ['migrations/1_x.sql', '../0001_x.sql', 'migrations/0001_X.sql', 'migrations/0001_a.sql;rm -rf /',
  'migrations/0001_a.txt', '/etc/0001_a.sql', 'migrations/0001_.sql', ''];

function fakeSpawn(result) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof result === 'function' ? result(cmd, args, opts) : result;
  };
  return { spawn, calls };
}

describe('migrationAuthors', () => {
  test('解析 git log 輸出（CRLF、空行、空白）並以陣列參數、不經 shell 呼叫 git', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_MIGRATIONS),
        fc.array(fc.oneof(baseEmailArb, fc.constant('')), { maxLength: 6 }),
        fc.constantFrom('\n', '\r\n'),
        padArb,
        (migration, lines, eol, pad) => {
          const stdout = lines.map(l => pad.replace(/[\r\n]/g, ' ') + l).join(eol) + eol;
          const { spawn, calls } = fakeSpawn({ status: 0, stdout });
          const r = migrationAuthors(migration, { cwd: '/repo', spawn });
          expect(r).toEqual({ ok: true, authors: lines.filter(Boolean) });
          expect(calls).toHaveLength(1);
          expect(calls[0].cmd).toBe('git');
          expect(calls[0].args).toEqual(['log', '--format=%ae', '--', migration]);
          expect(calls[0].opts.shell).toBe(false);
          expect(calls[0].opts.cwd).toBe('/repo');
        },
      ),
      { numRuns: 100 },
    );
  });

  test('無效遷移路徑不呼叫 git', () => {
    for (const m of [...INVALID_MIGRATIONS, null, 5]) {
      const { spawn, calls } = fakeSpawn({ status: 0, stdout: '' });
      expect(migrationAuthors(m, { spawn }).ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test('git 無法執行或結束碼非零時失敗', () => {
    const m = VALID_MIGRATIONS[0];
    expect(migrationAuthors(m, { spawn: fakeSpawn({ error: { code: 'ENOENT' } }).spawn }).ok).toBe(false);
    expect(migrationAuthors(m, { spawn: fakeSpawn({ status: 128, stdout: '' }).spawn }).ok).toBe(false);
  });
});

// ---------- CLI main()（注入 readFile 與 spawn） ----------

function runMain(argv, { doc, readFile, spawnResult = { status: 0, stdout: '' } } = {}) {
  const logs = [];
  const errors = [];
  const reads = [];
  const { spawn, calls } = fakeSpawn(spawnResult);
  const code = main(argv, {
    log: m => logs.push(m),
    error: m => errors.push(m),
    readFile: readFile ?? (path => { reads.push(path); return JSON.stringify(doc); }),
    spawn,
  });
  return { code, logs, errors, reads, calls };
}

describe('main CLI', () => {
  test('destructive：結束碼 0 若且唯若 oracle 允許，輸出一行 JSON', () => {
    fc.assert(
      fc.property(
        scenarioArb.filter(s => typeof s.approver === 'string' && s.approver.length > 0 && Array.isArray(s.authors)
          && s.authors.every(a => typeof a === 'string' && !/[\r\n]/.test(a))),
        fc.constantFrom(...VALID_MIGRATIONS),
        ({ doc, approver, authors }, migration) => {
          const stdout = authors.map(a => a).join('\n');
          const r = runMain(['destructive', '--approver', approver, '--migration', migration, '--file', 'approvers.json'],
            { doc, spawnResult: { status: 0, stdout } });
          // git 輸出會被逐行 trim 並略過空行，oracle 以相同的作者輸入判定
          const parsed = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          const expected = oracleAllowed(approver, doc, parsed);
          expect(r.code).toBe(expected ? 0 : 1);
          const out = expected ? r.logs : r.errors;
          expect(out).toHaveLength(1);
          const line = JSON.parse(out[0]);
          expect(line).toMatchObject({ command: 'destructive', approver, migration, allowed: expected });
          expect(r.reads).toEqual(['approvers.json']);
        },
      ),
      { numRuns: 150 },
    );
  });

  const doc = { schema: 1, approvers: [{ jenkinsId: 'alice', emails: ['alice@example.invalid'] }] };

  test('用法錯誤回傳 2 且不讀檔、不呼叫 git', () => {
    const cases = [
      [],
      ['unknown', '--approver', 'alice'],
      ['release'],
      ['release', '--approver'],
      ['release', '--approver', 'alice', '--migration', VALID_MIGRATIONS[0]],
      ['release', '--approver', 'alice', '--bogus', 'x'],
      ['destructive', '--approver', 'alice'],
      ...INVALID_MIGRATIONS.map(m => ['destructive', '--approver', 'alice', '--migration', m]),
    ];
    for (const argv of cases) {
      const r = runMain(argv, { doc });
      expect(r.code).toBe(2);
      expect(r.reads).toHaveLength(0);
      expect(r.calls).toHaveLength(0);
    }
  });

  test('destructive：允許、作者為核准人、git 失敗、清單無法讀取', () => {
    const argv = ['destructive', '--approver', 'alice', '--migration', VALID_MIGRATIONS[0]];
    expect(runMain(argv, { doc, spawnResult: { status: 0, stdout: 'bob@example.invalid\n' } }).code).toBe(0);
    expect(runMain(argv, { doc, spawnResult: { status: 0, stdout: 'bob@example.invalid\nAlice@Example.Invalid\n' } }).code).toBe(1);
    expect(runMain(argv, { doc, spawnResult: { status: 0, stdout: '' } }).code).toBe(1);
    expect(runMain(argv, { doc, spawnResult: { status: 128, stdout: '' } }).code).toBe(1);
    expect(runMain(argv, { doc, spawnResult: { error: { code: 'ENOENT' } } }).code).toBe(1);
    const unreadable = runMain(argv, { readFile: () => { throw new Error('ENOENT'); } });
    expect(unreadable.code).toBe(1);
    expect(unreadable.calls).toHaveLength(0);
    expect(runMain(argv, { readFile: () => '{not json' }).code).toBe(1);
  });

  test('release：核准人回傳 0，非核准人或無效清單回傳 1，不呼叫 git', () => {
    const ok = runMain(['release', '--approver', 'alice'], { doc });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.logs[0])).toMatchObject({ command: 'release', approver: 'alice', allowed: true });
    expect(ok.calls).toHaveLength(0);
    expect(runMain(['release', '--approver', 'mallory'], { doc }).code).toBe(1);
    expect(runMain(['release', '--approver', 'alice'], { doc: { approvers: [...doc.approvers, ...doc.approvers] } }).code).toBe(1);
  });
});

// ---------- repository 內的 ci/release-approvers.json（tasks 19.2） ----------

describe('ci/release-approvers.json', () => {
  const repoDoc = JSON.parse(readFileSync(DEFAULT_APPROVERS_FILE, 'utf8'));

  test('唯一的 Release_Approver 為 jacklin，且 approval 模組接受此清單', () => {
    expect(repoDoc.schema).toBe(1);
    expect(repoDoc.approvers).toEqual([{ jenkinsId: 'jacklin', emails: ['thawtunoo@gmail.com'] }]);
    expect(loadApprovers(repoDoc)).toEqual({ ok: true, approvers: [{ jenkinsId: 'jacklin', emails: ['thawtunoo@gmail.com'] }] });
    expect(isReleaseApprover('jacklin', repoDoc)).toBe(true);
    // CLI 以預設路徑讀取 repository 內的清單。
    const logs = [];
    expect(main(['release', '--approver', 'jacklin'], { log: (m) => logs.push(m), error: () => {} })).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({ command: 'release', approver: 'jacklin', allowed: true });
  });

  test('單一核准人：jacklin 撰寫的破壞性遷移無法被核准（Property 32）', () => {
    expect(destructiveApprovalAllowed('jacklin', repoDoc, ['thawtunoo@gmail.com']).allowed).toBe(false);
    expect(destructiveApprovalAllowed('jacklin', repoDoc, ['someone-else@example.invalid']).allowed).toBe(true);
  });
});
