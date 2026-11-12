// Creates the first administrator in the PostgreSQL database named by CAMPING_DATABASE_* (Req 9.1, 10.1).
// In the App_Image this file is /app/tools/create-admin.js (scripts/build-server.mjs).
// The password is read only from --password-file, a hidden terminal prompt, or piped stdin. It is never
// taken from arguments or environment variables, never printed, and never written to the audit log.
import { HttpError, validateUsername, validateDisplayName } from '../server/accounts.js';
import { describeTarget } from '../server/db/connect.js';
import {
  CliError, EXIT_FAIL, EXIT_OK, EXIT_USAGE, InputEnded, MAX_ATTEMPTS, PASSWORD_MISMATCH, askHidden, askLine,
  askNewPassword, databaseError, databaseFromEnv, nonInteractivePassword, openAccountService, parseArgs,
  readStdin, reportConfigErrors
} from './account-cli.mjs';

export { askHidden, askLine };

export const USAGE = [
  'Usage: bun run create-admin [--username <name>] [--display-name <name>] [--password-file <path>]',
  '       In the App_Image: bun /app/tools/create-admin.js [options]',
  '',
  'Creates the first administrator account in the PostgreSQL database named by CAMPING_DATABASE_HOST,',
  'CAMPING_DATABASE_PORT, CAMPING_DATABASE_NAME, CAMPING_DATABASE_USER, CAMPING_DATABASE_PASSWORD and',
  'CAMPING_DATABASE_SSLMODE. The migrations must already be applied. It refuses when accounts exist.',
  '',
  'The password is read from --password-file (the file holds the password on one line), otherwise',
  'from the terminal without echo (asked twice), otherwise from piped stdin (one line). It is never',
  'read from arguments or environment variables and never printed.',
  'Without a terminal, --username and --display-name are required.',
  '',
  'Options:',
  '  --username <name>       Account name; asked on the terminal when omitted.',
  '  --display-name <name>   Display name; asked on the terminal when omitted.',
  '  --password-file <path>  Read the password from this file.',
  '  --help                  Show this message.'
].join('\n');

export const TTY_REQUIRED = 'Without an interactive terminal, pass --username and --display-name and supply the password on stdin or with --password-file.';
export const ALREADY_SET_UP = 'Setup is already complete: this database already has accounts.';
export { PASSWORD_MISMATCH };

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
  isTTY = process.stdin.isTTY === true,
  prompt = askLine,
  promptHidden = askHidden,
  readInput = readStdin,
  out = console.log,
  err = console.error,
  openService = openAccountService,
  poolOptions = {}
} = {}) {
  const args = parseArgs(argv, ['--username', '--display-name', '--password-file']);
  if (!args || args.positional.length > 0 || (args.help && argv.length !== 1)) { err(USAGE); return EXIT_USAGE; }
  if (args.help) { out(USAGE); return EXIT_OK; }

  const config = databaseFromEnv(env);
  if (!config.ok) { reportConfigErrors(config.errors, err); return EXIT_USAGE; }
  const { database } = config;

  const optUsername = args.options['--username'], optDisplayName = args.options['--display-name'];
  if (!isTTY && (optUsername === undefined || optDisplayName === undefined)) { err(TTY_REQUIRED); return EXIT_FAIL; }
  let username = null, displayName = null, password;
  try {
    if (optUsername !== undefined) username = validateUsername(optUsername.trim());
    if (optDisplayName !== undefined) displayName = validateDisplayName(optDisplayName);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    err(error.message);
    return EXIT_USAGE;
  }
  try {
    password = await nonInteractivePassword({ file: args.options['--password-file'], isTTY, readInput });
  } catch (error) {
    if (!(error instanceof CliError || error instanceof HttpError)) throw error;
    err(error.message);
    return EXIT_FAIL;
  }

  let service;
  try { service = await openService(database, poolOptions); }
  catch (error) { err(databaseError(database, error)); return EXIT_FAIL; }
  try {
    if (!(await service.needsSetup())) { err(ALREADY_SET_UP); return EXIT_FAIL; }
    out(`Creating the first administrator in the database at ${describeTarget(database)}.`);

    if (username === null) username = await askValid(prompt, 'Username: ', value => validateUsername(value.trim()), err);
    if (username === null) { err('Too many invalid attempts.'); return EXIT_FAIL; }
    if (displayName === null) displayName = await askValid(prompt, 'Display name: ', value => validateDisplayName(value), err);
    if (displayName === null) { err('Too many invalid attempts.'); return EXIT_FAIL; }
    if (password === null) password = await askNewPassword(promptHidden, err);
    if (password === null) { err('Too many invalid attempts.'); return EXIT_FAIL; }

    try {
      await service.createFirstAdmin({ username, displayName, password }, { auditAction: 'setup.cli' });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) { err('Setup is already complete.'); return EXIT_FAIL; }
      if (error instanceof HttpError) { err(error.message); return EXIT_FAIL; }
      err(databaseError(database, error));
      return EXIT_FAIL;
    }
    out(`Administrator ${username} created. Sign in at /login.`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof InputEnded) { err('Input ended; no account was created.'); return EXIT_FAIL; }
    err(databaseError(database, error));
    return EXIT_FAIL;
  } finally {
    await service.close();
  }
}

if (import.meta.main) process.exitCode = await runCreateAdmin();
