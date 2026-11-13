// The create-admin CLI (Req 9.1, 10.1). runCreateAdmin is driven with injected prompts against a
// PostgreSQL Ephemeral_Database (CAMPING_TEST_DATABASE_*, tests/support/pg.js): the CLI reads the
// connection from CAMPING_DATABASE_* built from the test config, and poolOptions points its pool at the
// test schema. askHidden is driven with fake terminal streams.
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, HttpError } from '../server/accounts.js';
import { runCreateAdmin, askHidden, USAGE, TTY_REQUIRED, PASSWORD_MISMATCH, ALREADY_SET_UP } from '../scripts/create-admin.mjs';
import { useTestDatabase, resetTables, serviceDb, testQuery } from './support/pg.js';

const PASS = 'correct horse battery';
const db = useTestDatabase();

beforeEach(async () => { await resetTables(db.sql); });

/** CAMPING_DATABASE_* for the test database, as the CLI reads them on the Deploy_Host. */
function pgEnv(extra = {}) {
  const c = db.config;
  return {
    CAMPING_DATABASE_HOST: c.host, CAMPING_DATABASE_PORT: String(c.port), CAMPING_DATABASE_NAME: c.name,
    CAMPING_DATABASE_USER: c.user, CAMPING_DATABASE_PASSWORD: c.password, CAMPING_DATABASE_SSLMODE: c.sslmode, ...extra
  };
}

/** Returns a prompt function that answers from a queue and records each question. */
function queue(answers) {
  const asked = [];
  const fn = mock(async question => {
    asked.push(question);
    if (answers.length === 0) throw new Error('Input ended.');
    return answers.shift();
  });
  fn.asked = asked;
  return fn;
}

function run({ lines = [], hidden = [], env = pgEnv(), ...rest } = {}) {
  const out = [], err = [];
  const prompt = queue([...lines]), promptHidden = queue([...hidden]);
  const readInput = mock(async () => { throw new Error('stdin should not be read'); });
  const promise = runCreateAdmin({
    argv: [], env, isTTY: true, prompt, promptHidden, readInput, poolOptions: { connection: db.sessionParams },
    out: (...a) => out.push(a.join(' ')), err: (...a) => err.push(a.join(' ')), ...rest
  });
  return { promise, out, err, prompt, promptHidden, readInput };
}

async function readDb() {
  return {
    users: await testQuery(db.sql, 'SELECT username, display_name, role FROM users ORDER BY username'),
    audit: await testQuery(db.sql, 'SELECT actor, action, target FROM audit ORDER BY id')
  };
}

const service = () => createAccountService({ db: serviceDb(db.sql) });

async function login(svc, username, password) {
  return svc.handle(new Request('http://127.0.0.1:5173/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ username, password })
  }), { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false });
}

describe('runCreateAdmin', () => {
  test('creates the administrator with audit setup.cli and never shows or stores the password', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(0);
    expect(r.out.at(-1)).toBe('Administrator alice created. Sign in at /login.');
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain(PASS);
    expect(all).not.toContain(db.config.password);
    const { users, audit } = await readDb();
    expect(users).toEqual([{ username: 'alice', display_name: 'Alice', role: 'admin' }]);
    expect(audit).toEqual([{ actor: 'alice', action: 'setup.cli', target: 'user:alice' }]);
    expect(JSON.stringify(audit)).not.toContain(PASS);
    expect(r.readInput).not.toHaveBeenCalled();
  });

  test('refuses when a user already exists and leaves the database unchanged', async () => {
    const svc = await service();
    await svc.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: PASS });
    svc.close();
    const before = await readDb();
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain(ALREADY_SET_UP);
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expect(await readDb()).toEqual(before);
  });

  test('prints the validation message and asks again for an invalid username', async () => {
    const r = run({ lines: ['Bad Name', 'alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(0);
    expect(r.prompt.asked).toEqual(['Username: ', 'Username: ', 'Display name: ']);
    expect(r.err).toContain('帳號需為 3–32 個小寫英數字或連字號，並以英文字母開頭。');
    expect((await readDb()).users.map(u => u.username)).toEqual(['alice']);
  });

  test('stops after 5 invalid usernames without creating an account', async () => {
    const r = run({ lines: ['x', 'x', 'x', 'x', 'x', 'alice'] });
    expect(await r.promise).toBe(1);
    expect(r.prompt).toHaveBeenCalledTimes(5);
    expect((await readDb()).users).toEqual([]);
  });

  test('a mismatched confirmation prints the message and re-asks both password entries', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, 'something else!!', PASS, PASS] });
    expect(await r.promise).toBe(0);
    expect(r.err).toContain(PASSWORD_MISMATCH);
    expect(r.promptHidden.asked).toEqual(['Password (12–128 characters): ', 'Confirm password: ', 'Password (12–128 characters): ', 'Confirm password: ']);
    expect([...r.out, ...r.err].join('\n')).not.toContain(PASS);
  });

  test('a password argument exits 2 with usage before any prompt or database connection', async () => {
    for (const argv of [['--password', 'x'], [`--password=${PASS}`], [PASS]]) {
      const openService = mock(() => { throw new Error('should not open'); });
      const r = run({ argv, openService });
      expect(await r.promise).toBe(2);
      expect(r.err).toEqual([USAGE]);
      expect(r.prompt).not.toHaveBeenCalled();
      expect(r.promptHidden).not.toHaveBeenCalled();
      expect(openService).not.toHaveBeenCalled();
    }
  });

  test('--help prints usage and exits 0', async () => {
    const r = run({ argv: ['--help'] });
    expect(await r.promise).toBe(0);
    expect(r.out).toEqual([USAGE]);
    expect(r.prompt).not.toHaveBeenCalled();
  });

  test('without a terminal and without --username/--display-name it exits 1 with TTY_REQUIRED', async () => {
    const r = run({ isTTY: false, lines: ['alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(1);
    expect(r.err).toEqual([TTY_REQUIRED]);
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expect(r.readInput).not.toHaveBeenCalled();
  });

  test('without a terminal the password is read from piped stdin', async () => {
    const readInput = mock(async () => Buffer.from(`${PASS}\n`));
    const r = run({ isTTY: false, argv: ['--username', 'alice', '--display-name', 'Alice'], readInput });
    expect(await r.promise).toBe(0);
    expect(readInput).toHaveBeenCalledTimes(1);
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expect([...r.out, ...r.err].join('\n')).not.toContain(PASS);
    const svc = await service();
    try { expect((await login(svc, 'alice', PASS)).status).toBe(200); } finally { svc.close(); }
  });

  test('--password-file reads one line; a file with more lines is refused without creating an account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-admin-'));
    try {
      const bad = join(dir, 'two-lines.txt');
      writeFileSync(bad, `${PASS}\nsecond line\n`);
      const refused = run({ argv: ['--password-file', bad], lines: ['alice', 'Alice'] });
      expect(await refused.promise).toBe(1);
      expect(refused.err).toEqual(['Password input must be a single line.']);
      expect((await readDb()).users).toEqual([]);

      const good = join(dir, 'password.txt');
      writeFileSync(good, `${PASS}\r\n`);
      const r = run({ argv: ['--password-file', good], lines: ['alice', 'Alice'] });
      expect(await r.promise).toBe(0);
      expect(r.promptHidden).not.toHaveBeenCalled();
      expect([...refused.out, ...refused.err, ...r.out, ...r.err].join('\n')).not.toContain(PASS);
      const svc = await service();
      try { expect((await login(svc, 'alice', PASS)).status).toBe(200); } finally { svc.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('CAMPING_ADMIN_PASSWORD in the environment is ignored', async () => {
    const envPassword = 'environment password 123';
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], env: pgEnv({ CAMPING_ADMIN_PASSWORD: envPassword }) });
    expect(await r.promise).toBe(0);
    expect(r.promptHidden).toHaveBeenCalledTimes(2);
    expect([...r.out, ...r.err].join('\n')).not.toContain(envPassword);
    // The prompted password works; the environment one does not.
    const svc = await service();
    try {
      expect((await login(svc, 'alice', PASS)).status).toBe(200);
      expect((await login(svc, 'alice', envPassword)).status).toBe(401);
    } finally { svc.close(); }
  });

  test('missing CAMPING_DATABASE_* exits 2 naming only the variables, before opening a service', async () => {
    const openService = mock(() => { throw new Error('should not open'); });
    const env = { CAMPING_DATABASE_HOST: 'db.invalid', CAMPING_DATABASE_PASSWORD: 'not-printed-value', CAMPING_DB: 'data/accounts.sqlite' };
    const r = run({ env, openService });
    expect(await r.promise).toBe(2);
    expect(openService).not.toHaveBeenCalled();
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.err.join('\n')).toContain('CAMPING_DATABASE_NAME');
    expect(r.err.join('\n')).toContain('CAMPING_DATABASE_USER');
    expect(r.err.join('\n')).not.toContain('CAMPING_DATABASE_HOST');
    expect([...r.out, ...r.err].join('\n')).not.toContain('not-printed-value');
  });

  test('an unreachable database exits 1 with host and port only', async () => {
    const r = run({ env: pgEnv({ CAMPING_DATABASE_HOST: '127.0.0.1', CAMPING_DATABASE_PORT: '1', CAMPING_DATABASE_PASSWORD: 'not-printed-value' }), poolOptions: { connectionTimeout: 2 } });
    expect(await r.promise).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith('Cannot use the database at 127.0.0.1:1 (');
    expect(r.err[0]).not.toContain('not-printed-value');
    expect(r.prompt).not.toHaveBeenCalled();
  });

  test('ended input exits 1 without creating an account', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [] });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain('Input ended; no account was created.');
    expect((await readDb()).users).toEqual([]);
  });
});

describe('createFirstAdmin concurrency', () => {
  test('two services on the same database: exactly one succeeds, the other gets 409', async () => {
    const a = await service(), b = await service();
    try {
      const results = await Promise.allSettled([
        a.createFirstAdmin({ username: 'alice', displayName: 'Alice', password: PASS }, { auditAction: 'setup.cli' }),
        b.createFirstAdmin({ username: 'bob', displayName: 'Bob', password: PASS }, { auditAction: 'setup.cli' })
      ]);
      const ok = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0].reason).toBeInstanceOf(HttpError);
      expect(failed[0].reason.status).toBe(409);
    } finally { a.close(); b.close(); }
    const { users, audit } = await readDb();
    expect(users).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('runCreateAdmin reports a concurrent creation as already complete', async () => {
    const real = await service();
    // Another process creates an admin between the setup check and the insert.
    const openService = async () => ({
      needsSetup: async () => true,
      async createFirstAdmin(input, options) {
        const other = await service();
        try { await other.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: PASS }); } finally { other.close(); }
        return real.createFirstAdmin(input, options);
      },
      close: async () => real.close()
    });
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], openService });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain('Setup is already complete.');
    expect((await readDb()).users.map(u => u.username)).toEqual(['owner']);
  });
});

function fakeTerminal() {
  const stdin = new EventEmitter();
  stdin.isRaw = false;
  stdin.setRawMode = mock(mode => { stdin.isRaw = mode; return stdin; });
  stdin.resume = mock(() => {});
  stdin.pause = mock(() => {});
  const writes = [];
  const stdout = { write: mock(text => { writes.push(text); return true; }) };
  return { stdin, stdout, writes };
}

describe('askHidden', () => {
  test('reads without echo, handles backspace, and restores raw mode', async () => {
    const { stdin, stdout, writes } = fakeTerminal();
    const answer = askHidden('Password: ', { stdin, stdout, exit: mock(() => {}) });
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    stdin.emit('data', Buffer.from('secrex'));
    stdin.emit('data', '\x7f');
    stdin.emit('data', 't\b');
    stdin.emit('data', 't-pw\r');
    expect(await answer).toBe('secret-pw');
    expect(writes).toEqual(['Password: ', '\n']);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.listenerCount('end')).toBe(0);
  });

  test('Ctrl+D on an empty buffer rejects and restores raw mode', async () => {
    const { stdin, stdout } = fakeTerminal();
    const answer = askHidden('Password: ', { stdin, stdout, exit: mock(() => {}) });
    stdin.emit('data', '\x04');
    await expect(answer).rejects.toThrow('Input ended.');
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  test('Ctrl+C restores raw mode and calls exit(130)', async () => {
    const { stdin, stdout, writes } = fakeTerminal();
    const exit = mock(() => {});
    const answer = askHidden('Password: ', { stdin, stdout, exit });
    stdin.emit('data', 'abc\x03');
    await expect(answer).rejects.toThrow();
    expect(exit).toHaveBeenCalledWith(130);
    expect(stdin.isRaw).toBe(false);
    expect(writes.join('')).not.toContain('abc');
  });

  test('stream end rejects', async () => {
    const { stdin, stdout } = fakeTerminal();
    const answer = askHidden('Password: ', { stdin, stdout, exit: mock(() => {}) });
    stdin.emit('end');
    await expect(answer).rejects.toThrow('Input ended.');
  });
});
