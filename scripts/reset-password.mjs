import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createAccountService, HttpError, validatePassword, validateUsername } from '../server/accounts.js';
import { resolveDbPath } from '../server/deploy-config.js';
import { askHidden } from './create-admin.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ATTEMPTS = 5;

export const USAGE = [
  'Usage: bun run reset-password <username>',
  '',
  'Sets a new password for an existing account in the database named by CAMPING_DB',
  '(default: data/accounts.sqlite). It invalidates that account’s active sessions.',
  'The password is entered interactively and is never read from arguments or the environment.',
  '',
  'Options:',
  '  --help  Show this message.'
].join('\n');

class InputEnded extends Error {}

export function askLine(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
    let answered = false;
    rl.once('close', () => { if (!answered) reject(new Error('Input ended.')); });
    rl.question(question, answer => { answered = true; rl.close(); resolvePromise(answer); });
  });
}

export async function runResetPassword({
  argv = process.argv.slice(2),
  env = process.env,
  projectRoot = PROJECT_ROOT,
  isTTY = process.stdin.isTTY === true,
  prompt = askLine,
  promptHidden = askHidden,
  out = console.log,
  err = console.error,
  openService = dbPath => createAccountService({ dbPath })
} = {}) {
  if (argv.length === 1 && argv[0] === '--help') { out(USAGE); return 0; }
  if (argv.length !== 1) { err(USAGE); return 2; }
  if (!isTTY) { err('An interactive terminal is required; the password is never read from arguments, environment variables, or piped input.'); return 1; }

  let username;
  try { username = validateUsername(argv[0]); }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    err(error.message);
    return 2;
  }

  const dbPath = resolveDbPath(env, projectRoot);
  if (dbPath === ':memory:') { err('CAMPING_DB must name a database file, not :memory:.'); return 1; }
  const service = openService(dbPath);
  try {
    let password = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && password === null; attempt += 1) {
      let first, second;
      try { first = await promptHidden('New password (12–128 characters): '); } catch { throw new InputEnded(); }
      try { validatePassword(first); } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        err(error.message);
        continue;
      }
      try { second = await promptHidden('Confirm new password: '); } catch { throw new InputEnded(); }
      if (first !== second) { err('兩次輸入的密碼不一致。'); continue; }
      password = first;
    }
    if (password === null) { err('Too many invalid attempts.'); return 1; }

    try { await service.resetPassword(username, password); }
    catch (error) {
      if (error instanceof HttpError) { err(error.message); return 1; }
      throw error;
    }
    out(`Password reset for ${username}. All existing sessions for this account have been signed out.`);
    return 0;
  } catch (error) {
    if (error instanceof InputEnded) { err('Input ended; the password was not changed.'); return 1; }
    throw error;
  } finally {
    service.close();
  }
}

if (import.meta.main) process.exitCode = await runResetPassword();
