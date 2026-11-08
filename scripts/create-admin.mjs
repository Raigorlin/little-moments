// Creates the first administrator in the database named by CAMPING_DB (Req 8.6–8.16).
// The password is read only from an interactive prompt with no echo. It is never taken from
// arguments or environment variables, never printed, and never written to the audit log.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createAccountService, HttpError, validateUsername, validateDisplayName, validatePassword } from '../server/accounts.js';
import { ENV, resolveDbPath } from '../server/deploy-config.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ATTEMPTS = 5;

export const USAGE = [
  'Usage: bun run create-admin',
  '',
  'Creates the first administrator account in the SQLite database at CAMPING_DB',
  '(default: data/accounts.sqlite). Run it on the server, as the same OS user and with',
  'the same CAMPING_DB as the app. It asks for the username, display name, and password',
  'on the terminal. The password is never read from arguments, environment variables,',
  'or piped input.',
  '',
  'Options:',
  '  --help  Show this message.'
].join('\n');

export const TTY_REQUIRED = 'An interactive terminal is required; the password is never read from arguments, environment variables, or piped input.';
export const PASSWORD_MISMATCH = '兩次輸入的密碼不一致。';

/** Asks one question on the terminal with echo. Rejects when input ends before an answer. */
export function askLine(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
    let answered = false;
    rl.once('close', () => { if (!answered) reject(new Error('Input ended.')); });
    rl.question(question, answer => { answered = true; rl.close(); resolvePromise(answer); });
  });
}

/**
 * Asks one question with no echo. Uses raw mode when the stream supports it and always restores it.
 * Backspace (\x7f, \b) removes one character, Ctrl+C (\x03) restores the mode and exits 130,
 * Ctrl+D (\x04) on an empty buffer rejects. Ends with a newline on stdout.
 */
export function askHidden(question, { stdin = process.stdin, stdout = process.stdout, exit = code => process.exit(code) } = {}) {
  stdout.write(question);
  const canRaw = typeof stdin.setRawMode === 'function';
  const wasRaw = canRaw && stdin.isRaw === true;
  let onData, onEnd;
  const done = new Promise((resolvePromise, reject) => {
    let chars = [];
    onEnd = () => reject(new Error('Input ended.'));
    onData = chunk => {
      for (const ch of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { resolvePromise(chars.join('')); chars = []; return; }
        if (ch === '\x03') {
          if (canRaw) stdin.setRawMode(wasRaw);
          stdout.write('\n');
          exit(130);
          reject(new Error('Interrupted.'));
          return;
        }
        if (ch === '\x04') { if (chars.length === 0) { reject(new Error('Input ended.')); return; } continue; }
        if (ch === '\x7f' || ch === '\b') { chars.pop(); continue; }
        chars.push(ch);
      }
    };
  });
  if (canRaw) stdin.setRawMode(true);
  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.resume?.();
  return done.finally(() => {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    if (canRaw) stdin.setRawMode(wasRaw);
    stdin.pause?.();
    stdout.write('\n');
  });
}

function publicOrigin(env) {
  const origin = env?.[ENV.publicOrigin];
  if (origin) return String(origin).replace(/\/+$/, '');
  return `http://127.0.0.1:${env?.[ENV.port] || 5173}`;
}

class InputEnded extends Error {}

/** Asks until `check` accepts the answer, printing each validation message; null after 5 failures. */
async function askValid(ask, question, check, err) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let answer;
    try { answer = await ask(question); } catch { throw new InputEnded(); }
    try { return check(answer); } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      err(error.message);
    }
  }
  return null;
}

export async function runCreateAdmin({
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
  if (argv.length > 0) { err(USAGE); return 2; }
  if (!isTTY) { err(TTY_REQUIRED); return 1; }

  const dbPath = resolveDbPath(env, projectRoot);
  if (dbPath === ':memory:') { err('CAMPING_DB must name a database file, not :memory:.'); return 1; }

  const service = openService(dbPath);
  try {
    if (!service.needsSetup()) { err('Setup is already complete: this database already has accounts.'); return 1; }
    out(`Creating the first administrator in ${dbPath}.`);

    const username = await askValid(prompt, 'Username: ', value => validateUsername(value.trim()), err);
    if (username === null) { err('Too many invalid attempts.'); return 1; }
    const displayName = await askValid(prompt, 'Display name: ', value => validateDisplayName(value), err);
    if (displayName === null) { err('Too many invalid attempts.'); return 1; }

    let password = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && password === null; attempt += 1) {
      let first, second;
      try { first = await promptHidden('Password (12–128 characters): '); } catch { throw new InputEnded(); }
      try { validatePassword(first); } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        err(error.message);
        continue;
      }
      try { second = await promptHidden('Confirm password: '); } catch { throw new InputEnded(); }
      if (first !== second) { err(PASSWORD_MISMATCH); continue; }
      password = first;
    }
    if (password === null) { err('Too many invalid attempts.'); return 1; }

    try {
      await service.createFirstAdmin({ username, displayName, password }, { auditAction: 'setup.cli' });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) { err('Setup is already complete.'); return 1; }
      if (error instanceof HttpError) { err(error.message); return 1; }
      throw error;
    }
    out(`Administrator ${username} created. Sign in at ${publicOrigin(env)}/login.`);
    return 0;
  } catch (error) {
    if (error instanceof InputEnded) { err('Input ended; no account was created.'); return 1; }
    throw error;
  } finally {
    service.close();
  }
}

if (import.meta.main) process.exitCode = await runCreateAdmin();
