// The create-admin CLI (Req 8.7, 8.9–8.16, 13.7). runCreateAdmin is driven with injected prompts
// against a temporary file database; askHidden is driven with fake terminal streams.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, HttpError } from '../server/accounts.js';
import { runCreateAdmin, askHidden, USAGE, TTY_REQUIRED, PASSWORD_MISMATCH } from '../scripts/create-admin.mjs';

const PASS = 'correct horse battery';
let dir, dbPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'create-admin-'));
  dbPath = join(dir, 'accounts.sqlite');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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

function run({ lines = [], hidden = [], env = { CAMPING_DB: dbPath }, ...rest } = {}) {
  const out = [], err = [];
  const prompt = queue([...lines]), promptHidden = queue([...hidden]);
  const promise = runCreateAdmin({
    argv: [], env, projectRoot: dir, isTTY: true, prompt, promptHidden,
    out: (...a) => out.push(a.join(' ')), err: (...a) => err.push(a.join(' ')), ...rest
  });
  return { promise, out, err, prompt, promptHidden };
}

function readDb(path = dbPath) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      users: db.query('SELECT username, display_name, role FROM users').all(),
      audit: db.query('SELECT actor, action, target FROM audit').all()
    };
  } finally { db.close(); }
}

describe('runCreateAdmin', () => {
  test('creates the administrator with audit setup.cli and never shows or stores the password', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], env: { CAMPING_DB: dbPath, CAMPING_PUBLIC_ORIGIN: 'https://www.our-littlemoments.com/' } });
    expect(await r.promise).toBe(0);
    expect(r.out.at(-1)).toBe('Administrator alice created. Sign in at https://www.our-littlemoments.com/login.');
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain(PASS);
    const { users, audit } = readDb();
    expect(users).toEqual([{ username: 'alice', display_name: 'Alice', role: 'admin' }]);
    expect(audit).toEqual([{ actor: 'alice', action: 'setup.cli', target: 'user:alice' }]);
    expect(JSON.stringify(audit)).not.toContain(PASS);
  });

  test('uses http://127.0.0.1:<PORT> when no public origin is set', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], env: { CAMPING_DB: dbPath, PORT: '8080' } });
    expect(await r.promise).toBe(0);
    expect(r.out.at(-1)).toBe('Administrator alice created. Sign in at http://127.0.0.1:8080/login.');
  });

  test('refuses when a user already exists and leaves the database unchanged', async () => {
    const service = createAccountService({ dbPath });
    await service.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: PASS });
    service.close();
    const before = readDb();
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain('Setup is already complete: this database already has accounts.');
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expect(readDb()).toEqual(before);
  });

  test('prints the validation message and asks again for an invalid username', async () => {
    const r = run({ lines: ['Bad Name', 'alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(0);
    expect(r.prompt.asked).toEqual(['Username: ', 'Username: ', 'Display name: ']);
    expect(r.err).toContain('帳號需為 3–32 個小寫英數字或連字號，並以英文字母開頭。');
    expect(readDb().users.map(u => u.username)).toEqual(['alice']);
  });

  test('stops after 5 invalid usernames without creating an account', async () => {
    const r = run({ lines: ['x', 'x', 'x', 'x', 'x', 'alice'] });
    expect(await r.promise).toBe(1);
    expect(r.prompt).toHaveBeenCalledTimes(5);
    expect(readDb().users).toEqual([]);
  });

  test('a mismatched confirmation prints the message and re-asks both password entries', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, 'something else!!', PASS, PASS] });
    expect(await r.promise).toBe(0);
    expect(r.err).toContain(PASSWORD_MISMATCH);
    expect(r.promptHidden.asked).toEqual(['Password (12–128 characters): ', 'Confirm password: ', 'Password (12–128 characters): ', 'Confirm password: ']);
    expect([...r.out, ...r.err].join('\n')).not.toContain(PASS);
  });

  test('a password argument exits 2 with usage before any prompt', async () => {
    const r = run({ argv: ['--password', 'x'] });
    expect(await r.promise).toBe(2);
    expect(r.err).toEqual([USAGE]);
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(false);
  });

  test('--help prints usage and exits 0', async () => {
    const r = run({ argv: ['--help'] });
    expect(await r.promise).toBe(0);
    expect(r.out).toEqual([USAGE]);
    expect(r.prompt).not.toHaveBeenCalled();
  });

  test('without a terminal it exits 1 with TTY_REQUIRED', async () => {
    const r = run({ isTTY: false, lines: ['alice', 'Alice'], hidden: [PASS, PASS] });
    expect(await r.promise).toBe(1);
    expect(r.err).toEqual([TTY_REQUIRED]);
    expect(r.prompt).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
  });

  test('CAMPING_ADMIN_PASSWORD in the environment is ignored', async () => {
    const envPassword = 'environment password 123';
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], env: { CAMPING_DB: dbPath, CAMPING_ADMIN_PASSWORD: envPassword } });
    expect(await r.promise).toBe(0);
    expect(r.promptHidden).toHaveBeenCalledTimes(2);
    expect([...r.out, ...r.err].join('\n')).not.toContain(envPassword);
    // The prompted password works; the environment one does not.
    const service = createAccountService({ dbPath });
    try {
      const login = password => service.handle(new Request('http://127.0.0.1:5173/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ username: 'alice', password })
      }), { requestIP: () => ({ address: '127.0.0.1' }) });
      expect((await login(PASS))?.status).toBe(200);
      expect((await login(envPassword))?.status).toBe(401);
    } finally { service.close(); }
  });

  test(':memory: is refused with exit 1 before opening a service', async () => {
    const openService = mock(() => { throw new Error('should not open'); });
    const r = run({ env: { CAMPING_DB: ':memory:' }, openService });
    expect(await r.promise).toBe(1);
    expect(openService).not.toHaveBeenCalled();
    expect(r.prompt).not.toHaveBeenCalled();
  });

  test('ended input exits 1 without creating an account', async () => {
    const r = run({ lines: ['alice', 'Alice'], hidden: [] });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain('Input ended; no account was created.');
    expect(readDb().users).toEqual([]);
  });
});

describe('createFirstAdmin concurrency', () => {
  test('two services on the same file: exactly one succeeds, the other gets 409', async () => {
    const a = createAccountService({ dbPath }), b = createAccountService({ dbPath });
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
    const { users, audit } = readDb();
    expect(users).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('runCreateAdmin reports a concurrent creation as already complete', async () => {
    const real = createAccountService({ dbPath });
    // Another process creates an admin between the setup check and the insert.
    const openService = () => ({
      needsSetup: () => true,
      async createFirstAdmin(input, options) {
        const other = createAccountService({ dbPath });
        try { await other.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: PASS }); } finally { other.close(); }
        return real.createFirstAdmin(input, options);
      },
      close: () => real.close()
    });
    const r = run({ lines: ['alice', 'Alice'], hidden: [PASS, PASS], openService });
    expect(await r.promise).toBe(1);
    expect(r.err).toContain('Setup is already complete.');
    expect(readDb().users.map(u => u.username)).toEqual(['owner']);
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
