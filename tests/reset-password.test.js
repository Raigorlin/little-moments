// The reset-password CLI against a PostgreSQL Ephemeral_Database (CAMPING_TEST_DATABASE_*, tests/support/pg.js).
// The CLI reads CAMPING_DATABASE_* built from the test config; poolOptions points its pool at the test schema.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { runResetPassword, USAGE } from '../scripts/reset-password.mjs';
import { useTestDatabase, resetTables, serviceDb, testQuery } from './support/pg.js';

const OLD_PASSWORD = 'original test password';
const NEW_PASSWORD = 'replacement test password';
const db = useTestDatabase();

beforeEach(async () => { await resetTables(db.sql); });

function pgEnv() {
  const c = db.config;
  return {
    CAMPING_DATABASE_HOST: c.host, CAMPING_DATABASE_PORT: String(c.port), CAMPING_DATABASE_NAME: c.name,
    CAMPING_DATABASE_USER: c.user, CAMPING_DATABASE_PASSWORD: c.password, CAMPING_DATABASE_SSLMODE: c.sslmode
  };
}

function queue(answers) {
  return mock(async () => {
    if (!answers.length) throw new Error('Input ended.');
    return answers.shift();
  });
}

function run({ argv = ['jacklin'], hidden = [], ...rest } = {}) {
  const out = [], err = [];
  const promptHidden = queue([...hidden]);
  const promise = runResetPassword({
    argv, env: pgEnv(), isTTY: true, promptHidden, poolOptions: { connection: { search_path: db.schema } },
    readInput: async () => { throw new Error('stdin should not be read'); },
    out: (...args) => out.push(args.join(' ')), err: (...args) => err.push(args.join(' ')), ...rest
  });
  return { promise, out, err, promptHidden };
}

const service = () => createAccountService({ db: serviceDb(db.sql) });

async function login(svc, username, password) {
  return svc.handle(new Request('http://127.0.0.1:5173/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ username, password })
  }), { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false });
}

async function seedAdmin() {
  const svc = await service();
  await svc.createFirstAdmin({ username: 'jacklin', displayName: 'Jack', password: OLD_PASSWORD });
  return svc;
}

async function expectPassword(password, wrong) {
  const svc = await service();
  try {
    expect((await login(svc, 'jacklin', wrong)).status).toBe(401);
    expect((await login(svc, 'jacklin', password)).status).toBe(200);
  } finally { svc.close(); }
}

describe('runResetPassword', () => {
  test('changes password, revokes sessions, and never prints or audits the password', async () => {
    const setup = await seedAdmin();
    const oldLogin = await login(setup, 'jacklin', OLD_PASSWORD);
    expect(oldLogin.status).toBe(200);
    setup.close();

    const result = run({ hidden: [NEW_PASSWORD, NEW_PASSWORD] });
    expect(await result.promise).toBe(0);
    expect(result.out).toEqual(['Password reset for jacklin. All existing sessions for this account have been signed out.']);
    expect([...result.out, ...result.err].join('\n')).not.toContain(NEW_PASSWORD);

    const svc = await service();
    try {
      const oldSession = await svc.handle(new Request('http://127.0.0.1:5173/api/session', {
        headers: { cookie: oldLogin.headers.get('set-cookie').split(';')[0] }
      }), { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false });
      expect(oldSession.status).toBe(200);
      expect(await oldSession.json()).toMatchObject({ user: null });
    } finally { svc.close(); }
    await expectPassword(NEW_PASSWORD, OLD_PASSWORD);

    const audit = await testQuery(db.sql, "SELECT actor, action, target FROM audit WHERE action = 'password.reset.cli'");
    expect(audit).toEqual([{ actor: 'local-cli', action: 'password.reset.cli', target: 'user:jacklin' }]);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  test('rejects password arguments with usage before opening the database', async () => {
    for (const argv of [['jacklin', NEW_PASSWORD], ['jacklin', '--password', NEW_PASSWORD], [`--password=${NEW_PASSWORD}`, 'jacklin'], []]) {
      const openService = mock(() => { throw new Error('should not open'); });
      const result = run({ argv, openService });
      expect(await result.promise).toBe(2);
      expect(result.err).toEqual([USAGE]);
      expect(openService).not.toHaveBeenCalled();
      expect(result.promptHidden).not.toHaveBeenCalled();
    }
  });

  test('without a terminal the new password is read from piped stdin; --password-file reads one line', async () => {
    (await seedAdmin()).close();
    const piped = run({ isTTY: false, readInput: async () => Buffer.from(`${NEW_PASSWORD}\n`) });
    expect(await piped.promise).toBe(0);
    expect(piped.promptHidden).not.toHaveBeenCalled();
    await expectPassword(NEW_PASSWORD, OLD_PASSWORD);

    const dir = mkdtempSync(join(tmpdir(), 'reset-password-'));
    try {
      const file = join(dir, 'password.txt');
      writeFileSync(file, `${OLD_PASSWORD}\n`);
      const fromFile = run({ argv: ['jacklin', '--password-file', file] });
      expect(await fromFile.promise).toBe(0);
      expect(fromFile.promptHidden).not.toHaveBeenCalled();
      expect([...piped.out, ...piped.err, ...fromFile.out, ...fromFile.err].join('\n')).not.toMatch(new RegExp(`${OLD_PASSWORD}|${NEW_PASSWORD}`));
      await expectPassword(OLD_PASSWORD, NEW_PASSWORD);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('re-prompts after a confirmation mismatch before resetting', async () => {
    (await seedAdmin()).close();
    const result = run({ hidden: [NEW_PASSWORD, 'not the same password', NEW_PASSWORD, NEW_PASSWORD] });
    expect(await result.promise).toBe(0);
    expect(result.err).toContain('兩次輸入的密碼不一致。');
    await expectPassword(NEW_PASSWORD, OLD_PASSWORD);
  });

  test('an unknown account exits 1 and changes nothing', async () => {
    (await seedAdmin()).close();
    const result = run({ argv: ['nobody-here'], hidden: [NEW_PASSWORD, NEW_PASSWORD] });
    expect(await result.promise).toBe(1);
    expect(result.err).toEqual(['找不到這個帳號。']);
    await expectPassword(OLD_PASSWORD, NEW_PASSWORD);
  });
});
