// Shared input, password, and database helpers for the account CLIs (scripts/create-admin.mjs,
// scripts/reset-password.mjs, scripts/create-smoke-account.mjs). In the App_Image they are bundled into
// /app/tools/create-admin.js, /app/tools/reset-password.js and /app/tools/create-smoke-account.js by
// scripts/build-server.mjs.
//
// Passwords come only from a hidden terminal prompt, from piped stdin, or from a file named with
// --password-file. They are never read from arguments or environment variables and never printed.
// The database is the one named by CAMPING_DATABASE_* (validated by server/config.js parseConfig);
// errors name only the variables, never their values.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createAccountService, HttpError, validatePassword } from '../server/accounts.js';
import { parseConfig } from '../server/config.js';
import { createDatabase, describeTarget } from '../server/db/connect.js';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

/** Upper bound for a password file or piped password, in bytes. */
export const MAX_PASSWORD_INPUT_BYTES = 4096;

export const DATABASE_VARS = Object.freeze([
  'CAMPING_DATABASE_HOST', 'CAMPING_DATABASE_PORT', 'CAMPING_DATABASE_NAME',
  'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_DATABASE_SSLMODE'
]);

/** Invalid answers allowed per prompt before the CLI gives up. */
export const MAX_ATTEMPTS = 5;
export const PASSWORD_MISMATCH = '兩次輸入的密碼不一致。';

/** Terminal input ended (Ctrl+D or closed stream) before an answer. */
export class InputEnded extends Error {}

/** A user-facing failure whose message never contains a password or a setting value. */
export class CliError extends Error {
  constructor(message, code = EXIT_FAIL) { super(message); this.name = 'CliError'; this.exitCode = code; }
}

/**
 * Parses `--name value` options and positional arguments. `--help` is a flag. Any other option,
 * including `--password` and `--name=value` forms, is a usage error.
 * @returns {{help: boolean, options: Record<string,string>, positional: string[]} | null} null on a usage error
 */
export function parseArgs(argv, valueOptions) {
  const options = {}, positional = [];
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help') { help = true; continue; }
    if (a.startsWith('-')) {
      if (!valueOptions.includes(a) || i + 1 >= argv.length || Object.hasOwn(options, a)) return null;
      options[a] = argv[i += 1];
      continue;
    }
    positional.push(a);
  }
  return { help, options, positional };
}

/**
 * Reads the database part of the configuration: only CAMPING_DATABASE_* go to parseConfig, so the
 * CLI does not depend on the App_Server's other settings.
 * @returns {{ok: true, database: object} | {ok: false, errors: {name: string, reason: string}[]}}
 */
export function databaseFromEnv(env = process.env) {
  const parsed = parseConfig(Object.fromEntries(DATABASE_VARS.map(name => [name, env?.[name]])));
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, database: parsed.config.database };
}

/** Prints one line per setting problem, naming only the variable. */
export function reportConfigErrors(errors, err) {
  for (const e of errors) err(`設定錯誤 ${e.name}: ${e.reason}`);
}

/**
 * Opens the account service on its own small pool. close() stops the service and closes the pool.
 * `poolOptions` is passed to createDatabase (tests use it for an isolated search_path).
 */
export async function openAccountService(database, poolOptions = {}) {
  const db = createDatabase(database, { max: 2, connectionTimeout: 10, ...poolOptions });
  let service;
  try {
    service = await createAccountService({ db, alertLog: () => {} });
  } catch (error) {
    await db.close();
    throw error;
  }
  return {
    needsSetup: () => service.needsSetup(),
    createFirstAdmin: (input, options) => service.createFirstAdmin(input, options),
    resetPassword: (username, password) => service.resetPassword(username, password),
    provisionSmokeAccount: input => service.provisionSmokeAccount(input),
    close: async () => { service.close(); await db.close(); }
  };
}

/** A database failure described by host, port, and an error code only. */
export function databaseError(database, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : String(error?.message ?? '').match(/（([A-Z0-9_]{1,64})）/)?.[1] ?? 'ERROR';
  return `Cannot use the database at ${describeTarget(database)} (${code}). Check CAMPING_DATABASE_* and that the migrations have been applied.`;
}

/**
 * Turns password input into one password: drops a leading BOM and one trailing line break.
 * Any other line break is refused so a file with extra lines is never half-used.
 */
export function singleLinePassword(bytes) {
  if (bytes.length > MAX_PASSWORD_INPUT_BYTES) throw new CliError(`Password input is larger than ${MAX_PASSWORD_INPUT_BYTES} bytes.`);
  let text = Buffer.from(bytes).toString('utf8');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  text = text.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(text)) throw new CliError('Password input must be a single line.');
  return text;
}

/** Reads the password from a file. Errors name the file system error code, never the content. */
export function readPasswordFile(path, { readFile = readFileSync } = {}) {
  let bytes;
  try { bytes = readFile(path); }
  catch (error) { throw new CliError(`Cannot read the password file (${typeof error?.code === 'string' ? error.code : 'ERROR'}).`); }
  return singleLinePassword(bytes);
}

/**
 * Reads a password that does not come from the terminal: --password-file, or piped stdin when there is
 * no terminal. Returns null when the terminal prompt should be used. Throws CliError or HttpError.
 */
export async function nonInteractivePassword({ file, isTTY, readInput = readStdin }) {
  let password;
  if (file !== undefined) password = readPasswordFile(file);
  else if (!isTTY) password = singleLinePassword(await readInput());
  else return null;
  return validatePassword(password);
}

/** Prompts for a new password twice without echo; null after MAX_ATTEMPTS failures. Throws InputEnded. */
export async function askNewPassword(promptHidden, err, { first = 'Password (12–128 characters): ', confirm = 'Confirm password: ' } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let a, b;
    try { a = await promptHidden(first); } catch { throw new InputEnded(); }
    try { validatePassword(a); } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      err(error.message);
      continue;
    }
    try { b = await promptHidden(confirm); } catch { throw new InputEnded(); }
    if (a !== b) { err(PASSWORD_MISMATCH); continue; }
    return a;
  }
  return null;
}

/** Reads all of piped stdin, refusing more than MAX_PASSWORD_INPUT_BYTES. */
export async function readStdin(stdin = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_PASSWORD_INPUT_BYTES) throw new CliError(`Password input is larger than ${MAX_PASSWORD_INPUT_BYTES} bytes.`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

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
