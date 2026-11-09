import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { runResetPassword, USAGE } from '../scripts/reset-password.mjs';

const OLD_PASSWORD = 'original test password';
const NEW_PASSWORD = 'replacement test password';

function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'reset-password-'));
  return { dir, dbPath: join(dir, 'accounts.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function queue(answers) {
  return async () => {
    if (!answers.length) throw new Error('Input ended.');
    return answers.shift();
  };
}

function run({ dbPath, dir, argv = ['jacklin'], hidden = [], ...rest } = {}) {
  const out = [], err = [];
  const promise = runResetPassword({
    argv, env: { CAMPING_DB: dbPath }, projectRoot: dir, isTTY: true, promptHidden: queue([...hidden]),
    out: (...args) => out.push(args.join(' ')), err: (...args) => err.push(args.join(' ')), ...rest
  });
  return { promise, out, err };
}

async function login(service, username, password) {
  return service.handle(new Request('http://127.0.0.1:5173/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ username, password })
  }), { requestIP: () => ({ address: '127.0.0.1' }) });
}

describe('runResetPassword', () => {
  test('changes password, revokes sessions, and never prints or audits the password', async () => {
    const { dir, dbPath, cleanup } = tempDatabase();
    try {
    const setup = createAccountService({ dbPath });
    await setup.createFirstAdmin({ username: 'jacklin', displayName: 'Jack', password: OLD_PASSWORD });
    const oldLogin = await login(setup, 'jacklin', OLD_PASSWORD);
    expect(oldLogin.status).toBe(200);
    setup.close();

    const result = run({ dir, dbPath, hidden: [NEW_PASSWORD, NEW_PASSWORD] });
    expect(await result.promise).toBe(0);
    expect(result.out).toEqual(['Password reset for jacklin. All existing sessions for this account have been signed out.']);
    expect([...result.out, ...result.err].join('\n')).not.toContain(NEW_PASSWORD);

    const service = createAccountService({ dbPath });
    try {
      const oldSession = await service.handle(new Request('http://127.0.0.1:5173/api/session', {
        headers: { cookie: oldLogin.headers.get('set-cookie').split(';')[0] }
      }));
      expect(oldSession.status).toBe(200);
      expect(await oldSession.json()).toMatchObject({ user: null });
      expect((await login(service, 'jacklin', OLD_PASSWORD)).status).toBe(401);
      expect((await login(service, 'jacklin', NEW_PASSWORD)).status).toBe(200);
    } finally { service.close(); }

    const db = new Database(dbPath, { readonly: true });
    try {
      const audit = db.query("SELECT actor, action, target FROM audit WHERE action = 'password.reset.cli'").all();
      expect(audit).toEqual([{ actor: 'local-cli', action: 'password.reset.cli', target: 'user:jacklin' }]);
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    } finally { db.close(); }
    } finally { cleanup(); }
  });

  test('requires a TTY and rejects password arguments without opening the database', async () => {
    const { dir, dbPath, cleanup } = tempDatabase();
    try {
    const nonInteractive = run({ dir, dbPath, isTTY: false });
    expect(await nonInteractive.promise).toBe(1);
    expect(nonInteractive.err[0]).toContain('interactive terminal is required');

    const argumentPassword = run({ dir, dbPath, argv: ['jacklin', NEW_PASSWORD] });
    expect(await argumentPassword.promise).toBe(2);
    expect(argumentPassword.err).toEqual([USAGE]);
    expect(() => new Database(dbPath, { readonly: true })).toThrow();
    } finally { cleanup(); }
  });

  test('re-prompts after a confirmation mismatch before resetting', async () => {
    const { dir, dbPath, cleanup } = tempDatabase();
    try {
    const setup = createAccountService({ dbPath });
    await setup.createFirstAdmin({ username: 'jacklin', displayName: 'Jack', password: OLD_PASSWORD });
    setup.close();

    const result = run({ dir, dbPath, hidden: [NEW_PASSWORD, 'not the same password', NEW_PASSWORD, NEW_PASSWORD] });
    expect(await result.promise).toBe(0);
    expect(result.err).toContain('兩次輸入的密碼不一致。');

    const service = createAccountService({ dbPath });
    try {
      expect((await login(service, 'jacklin', OLD_PASSWORD)).status).toBe(401);
      expect((await login(service, 'jacklin', NEW_PASSWORD)).status).toBe(200);
    } finally { service.close(); }
    } finally { cleanup(); }
  });
});
