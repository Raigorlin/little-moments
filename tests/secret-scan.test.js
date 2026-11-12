import { test, expect, describe, afterAll } from 'bun:test';
import fc from 'fast-check';
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RULES, redact, scanText, shannonEntropy } from '../scripts/secret-rules.mjs';
import { runScan, MAX_FILE_BYTES, HISTORY_COMMAND } from '../scripts/scan-secrets.mjs';

// Planted secrets are assembled at runtime from fragments so that this file's own
// source text matches no scanner rule and the repository scan stays clean.
const DASH = '-';
const OPENAI_PREFIX = 'sk' + DASH;
const PEM_OPEN = DASH.repeat(5) + 'BEGIN ';
const PEM_CLOSE = 'PRIVATE KEY' + DASH.repeat(5);

const tempDirs = [];
const makeTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const EMPTY_ALLOWLIST = JSON.stringify({ entries: [] });
const writeAllowlist = (dir, data = EMPTY_ALLOWLIST) => {
  const file = join(dir, 'allowlist.json');
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};
// Allowlist files live outside the scanned root so they are not scanned themselves.
const scan = (root, allowlist) => runScan({ root, allowlist });
const allText = result => [...result.out, ...result.err].join('\n');

const randomChars = (alphabet, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
};
const LOWER_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const plantedOpenAiKey = () => OPENAI_PREFIX + 'proj' + DASH + randomChars(LOWER_DIGITS, 32);

// ---------- Generators for Property 19 ----------

const charsFrom = (alphabet, minLength, maxLength) =>
  fc.array(fc.constantFrom(...alphabet), { minLength, maxLength }).map(a => a.join(''));

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const passesEntropyRule = v =>
  v.length >= 20 && /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Za-z]/.test(v) &&
  !/AKIA|ASIA/.test(v) && shannonEntropy(v) >= 3.5;

// Each generator returns { line, secret } where `secret` is the value the rule reports.
const SECRET_GENERATORS = {
  'openai-key': fc.tuple(fc.boolean(), charsFrom(LOWER_DIGITS, 20, 48)).map(([proj, body]) => {
    const secret = OPENAI_PREFIX + (proj ? 'proj' + DASH : '') + body;
    return { line: `OPENAI = ${secret}`, secret };
  }),
  'aws-access-key': fc.tuple(fc.constantFrom('AKIA', 'ASIA'), charsFrom(UPPER_DIGITS, 16, 16)).map(([p, body]) => {
    const secret = p + body;
    return { line: `aws id ${secret} end`, secret };
  }),
  'pem-private-key': fc.constantFrom('', 'RSA ', 'EC ', 'OPENSSH ').map(kind => {
    const secret = PEM_OPEN + kind + PEM_CLOSE;
    return { line: secret, secret };
  }),
  'bearer-token': charsFrom(LOWER_DIGITS, 20, 48).map(value => ({
    line: `Authorization: ${'Bear' + 'er'} ${value}`,
    secret: value
  })),
  'url-credentials': fc.tuple(charsFrom('abcdefghij', 3, 10), charsFrom(LOWER_DIGITS, 8, 24)).map(([user, pass]) => ({
    line: `db ${'https:' + '//'}${user}:${pass}@db.example.test/x`,
    secret: pass
  })),
  'high-entropy-assignment': fc.tuple(
    fc.constantFrom('api_key', 'clientSecret', 'AUTH_TOKEN', 'db_password'),
    charsFrom(ALNUM, 20, 48).filter(passesEntropyRule)
  ).map(([name, value]) => ({ line: `${name} = "${value}"`, secret: value }))
};

// Filler lines use letters, spaces, commas, and periods only, so no rule can match them.
const fillerLine = charsFrom('abcdefghijklmnopqrstuvwxyz ,.', 0, 60);

describe('secret rules (pure)', () => {
  test('every rule has a generator', () => {
    expect(Object.keys(SECRET_GENERATORS).sort()).toEqual(RULES.map(r => r.id).sort());
  });

  // Feature: security-hardening, Property 19: Planted secrets are found at their line
  test('Property 19: planted secrets are found at their line', () => {
    const planted = fc.constantFrom(...RULES.map(r => r.id)).chain(rule =>
      fc.record({
        rule: fc.constant(rule),
        sample: SECRET_GENERATORS[rule],
        before: fc.array(fillerLine, { maxLength: 8 }),
        after: fc.array(fillerLine, { maxLength: 8 }),
        crlf: fc.boolean()
      }));
    fc.assert(
      fc.property(planted, ({ rule, sample, before, after, crlf }) => {
        const text = [...before, sample.line, ...after].join(crlf ? '\r\n' : '\n');
        const findings = scanText(text, { path: 'fixture.txt' });
        expect(findings).toHaveLength(1);
        expect(findings[0].rule).toBe(rule);
        expect(findings[0].line).toBe(before.length + 1);
        expect(findings[0].path).toBe('fixture.txt');
        expect(findings[0].redacted).toBe(redact(sample.secret));
        expect(JSON.stringify(findings)).not.toContain(sample.secret);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: security-hardening, Property 20: Redaction never reveals a secret
  test('Property 20: redaction shape for any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), s => {
        const chars = [...s];
        const out = redact(s);
        if (chars.length >= 16) {
          expect(out).toBe(chars.slice(0, 4).join('') + '…' + chars.slice(-4).join(''));
          expect(out).not.toContain(s);
        } else {
          expect(out).toBe('[redacted]');
        }
      }),
      { numRuns: 500 }
    );
  });

  // Feature: security-hardening, Property 20: Redaction never reveals a secret
  test('Property 20: full scanner output never contains a planted secret', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    const allowlist = writeAllowlist(root);
    const sample = fc.constantFrom(...RULES.map(r => r.id)).chain(rule => SECRET_GENERATORS[rule]);
    fc.assert(
      fc.property(sample, fc.array(fillerLine, { maxLength: 4 }), ({ line, secret }, filler) => {
        writeFileSync(join(scanRoot, 'planted.txt'), [...filler, line].join('\n'));
        const result = scan(scanRoot, allowlist);
        expect(result.code).toBe(1);
        expect(allText(result)).not.toContain(secret);
      }),
      // Each run is a full runScan, which spawns git twice (about 0.4 s on Windows).
      // The redaction function itself is covered with 500 runs in the test above.
      { numRuns: 25 }
    );
  }, 120_000);
});

describe('scan-secrets examples', () => {
  test('planted key is reported with file, line, rule, exit 1, and no full key', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(join(scanRoot, 'conf'), { recursive: true });
    const key = plantedOpenAiKey();
    writeFileSync(join(scanRoot, 'conf', 'app.txt'), `first line\nsecond line\nOPENAI = ${key}\n`);
    const result = scan(scanRoot, writeAllowlist(root));
    expect(result.code).toBe(1);
    expect(result.out).toContain(`FINDING conf/app.txt:3 rule=openai-key value=${redact(key)}`);
    expect(result.out).toContain('Findings: 1');
    expect(allText(result)).not.toContain(key);
  });

  test('the CLI exits 1 for a planted key and prints only the redacted value', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    const key = plantedOpenAiKey();
    writeFileSync(join(scanRoot, 'k.txt'), `key ${key}\n`);
    const cli = spawnSync(process.execPath, [resolve('scripts/scan-secrets.mjs'), '--root', scanRoot, '--allowlist', writeAllowlist(root)], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stdout + cli.stderr).toContain(redact(key));
    expect(cli.stdout + cli.stderr).not.toContain(key);
  });

  test('clean directory exits 0 with counts', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(join(scanRoot, 'sub'), { recursive: true });
    writeFileSync(join(scanRoot, 'a.txt'), 'hello world\n');
    writeFileSync(join(scanRoot, 'sub', 'b.js'), 'export const x = 1;\n');
    writeFileSync(join(scanRoot, 'c.bin'), Buffer.from([0, 1, 2, 3, 255]));
    const result = scan(scanRoot, writeAllowlist(root));
    expect(result.code).toBe(0);
    expect(result.out).toContain('Files scanned: 3');
    expect(result.out).toContain('Allowlisted matches: 0');
    expect(result.out).toContain('Findings: 0');
    expect(result.out.some(l => l.startsWith('Commits scanned: '))).toBe(true);
    expect(result.err).toEqual([]);
  });

  test('node_modules is not scanned', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(join(scanRoot, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(scanRoot, 'node_modules', 'pkg', 'k.txt'), plantedOpenAiKey());
    const result = scan(scanRoot, writeAllowlist(root));
    expect(result.code).toBe(0);
    expect(result.out).toContain('Files scanned: 0');
  });

  test('allowlisted value exits 0 and is counted', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    const key = plantedOpenAiKey();
    writeFileSync(join(scanRoot, 'fixture.txt'), `canary ${key}\n`);
    const allowlist = writeAllowlist(root, { entries: [{ value: key, reason: 'Test canary planted by this test.' }] });
    const result = scan(scanRoot, allowlist);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Allowlisted matches: 1');
    expect(result.out).toContain('Findings: 0');
    expect(allText(result)).not.toContain(key);
  });

  test('rule-and-path allowlist entry exits 0', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(join(scanRoot, 'tests'), { recursive: true });
    writeFileSync(join(scanRoot, 'tests', 'x.test.js'), `canary ${plantedOpenAiKey()}\n`);
    const allowlist = writeAllowlist(root, { entries: [{ rule: 'openai-key', path: 'tests/x.test.js', reason: 'Fake canary.' }] });
    const result = scan(scanRoot, allowlist);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Allowlisted matches: 1');
  });

  test('allowlist entry without a reason exits 2 without scanning', () => {
    for (const entry of [{ rule: 'openai-key', path: 'a.txt' }, { rule: 'openai-key', path: 'a.txt', reason: '   ' }]) {
      const root = makeTemp();
      const scanRoot = join(root, 'scan');
      mkdirSync(scanRoot);
      writeFileSync(join(scanRoot, 'a.txt'), 'plain\n');
      const result = scan(scanRoot, writeAllowlist(root, { entries: [entry] }));
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toContain('Allowlist entry 0 has a missing or empty reason.');
      expect(result.err).toContain('Scan not started.');
      expect(result.out.some(l => l.startsWith('Files scanned'))).toBe(false);
    }
  });

  test('unreadable file exits 2 and names the path', () => {
    // Windows: deny read access to the current user with icacls, which makes
    // readFileSync fail with EPERM while lstat still works. POSIX: chmod 000.
    // If the OS still lets the file be read (for example as root), the case is skipped.
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    const file = join(scanRoot, 'locked.txt');
    writeFileSync(file, 'plain text\n');
    let restore = () => {};
    if (process.platform === 'win32') {
      const who = spawnSync('whoami', { encoding: 'utf8' }).stdout?.trim();
      const deny = who ? spawnSync('icacls', [file, '/deny', `${who}:(R)`], { encoding: 'utf8' }) : null;
      if (!deny || deny.status !== 0) {
        console.log('Skipped unreadable-file case: icacls could not deny read access.');
        return;
      }
      restore = () => spawnSync('icacls', [file, '/remove:d', who], { encoding: 'utf8' });
    } else {
      chmodSync(file, 0o000);
      restore = () => chmodSync(file, 0o644);
    }
    try {
      let readable = true;
      try { readFileSync(file); } catch { readable = false; }
      if (readable) {
        console.log('Skipped unreadable-file case: the OS still allows reading the file.');
        return;
      }
      const result = scan(scanRoot, writeAllowlist(root));
      expect(result.code).toBe(2);
      expect(result.err.some(l => l.startsWith('Could not read file locked.txt'))).toBe(true);
      expect(result.err).toContain('Scan incomplete.');
    } finally {
      restore();
    }
  });

  test('non-repository directory prints the history notice and command without changing the exit code', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    writeFileSync(join(scanRoot, 'a.txt'), 'plain\n');
    const result = scan(scanRoot, writeAllowlist(root));
    expect(result.code).toBe(0);
    expect(result.out).toContain('Git history was not scanned: the scanned directory is not a git repository.');
    expect(result.out).toContain(`To scan history, run in the real repository clone: ${HISTORY_COMMAND}`);
    expect(result.out).toContain('Commits scanned: not scanned');
  });

  test('file over 50 MB is skipped with a notice', () => {
    const root = makeTemp();
    const scanRoot = join(root, 'scan');
    mkdirSync(scanRoot);
    // ftruncate extends the file without writing data (sparse on Linux and macOS;
    // NTFS records the size without writing the zero bytes).
    const big = join(scanRoot, 'big.bin');
    const fd = openSync(big, 'w');
    try { ftruncateSync(fd, MAX_FILE_BYTES + 1); } finally { closeSync(fd); }
    writeFileSync(join(scanRoot, 'small.txt'), 'plain\n');
    const result = scan(scanRoot, writeAllowlist(root));
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Skipped file over 50 MB: big.bin (${MAX_FILE_BYTES + 1} bytes)`);
    expect(result.out).toContain('Files skipped (over 50 MB): 1');
    expect(result.out).toContain('Files scanned: 1');
  });

  test('git history: a key added and then deleted is reported with commit hash and path', () => {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      console.log('Skipped git history case: git is not on PATH.');
      return;
    }
    const root = makeTemp();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=scan-test', '-c', 'user.email=scan-test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    git('init', '-q');
    const key = plantedOpenAiKey();
    writeFileSync(join(repo, 'config.txt'), `name = demo\nOPENAI = ${key}\n`);
    git('add', 'config.txt');
    git('commit', '-q', '-m', 'add config');
    const added = git('rev-parse', 'HEAD');
    git('rm', '-q', 'config.txt');
    git('commit', '-q', '-m', 'remove config');
    const head = git('rev-parse', 'HEAD');

    const result = scan(repo, writeAllowlist(root));
    expect(result.code).toBe(1);
    expect(added).toMatch(/^[0-9a-f]{40}$/);
    expect(result.out).toContain(`FINDING ${added}:config.txt rule=openai-key value=${redact(key)}`);
    expect(result.out).toContain(`Commits scanned: 2 (HEAD ${head})`);
    expect(result.out.some(l => l.includes('config.txt:') && !l.includes(added))).toBe(false);
    expect(result.out.some(l => l.startsWith('Git history was not scanned'))).toBe(false);
    expect(allText(result)).not.toContain(key);
  }, 30_000);
});
