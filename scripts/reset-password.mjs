// Sets a new password for an existing account in the PostgreSQL database named by CAMPING_DATABASE_*
// and signs that account out of every session. In the App_Image this file is /app/tools/reset-password.js
// (scripts/build-server.mjs). The password is read only from --password-file, a hidden terminal prompt,
// or piped stdin; it is never taken from arguments or environment variables and never printed.
import { HttpError, validateUsername } from '../server/accounts.js';
import {
  CliError, EXIT_FAIL, EXIT_OK, EXIT_USAGE, InputEnded, askHidden, askLine, askNewPassword, databaseError,
  databaseFromEnv, nonInteractivePassword, openAccountService, parseArgs, readStdin, reportConfigErrors
} from './account-cli.mjs';

export { askLine };

export const USAGE = [
  'Usage: bun run reset-password <username> [--password-file <path>]',
  '       In the App_Image: bun /app/tools/reset-password.js <username> [--password-file <path>]',
  '',
  'Sets a new password for an existing account in the PostgreSQL database named by CAMPING_DATABASE_HOST,',
  'CAMPING_DATABASE_PORT, CAMPING_DATABASE_NAME, CAMPING_DATABASE_USER, CAMPING_DATABASE_PASSWORD and',
  'CAMPING_DATABASE_SSLMODE, and signs that account out of all its sessions.',
  '',
  'The password is read from --password-file (the file holds the password on one line), otherwise',
  'from the terminal without echo (asked twice), otherwise from piped stdin (one line). It is never',
  'read from arguments or environment variables and never printed.',
  '',
  'Options:',
  '  --password-file <path>  Read the new password from this file.',
  '  --help                  Show this message.'
].join('\n');

export async function runResetPassword({
  argv = process.argv.slice(2),
  env = process.env,
  isTTY = process.stdin.isTTY === true,
  promptHidden = askHidden,
  readInput = readStdin,
  out = console.log,
  err = console.error,
  openService = openAccountService,
  poolOptions = {}
} = {}) {
  const args = parseArgs(argv, ['--password-file']);
  if (args?.help && argv.length === 1) { out(USAGE); return EXIT_OK; }
  if (!args || args.help || args.positional.length !== 1) { err(USAGE); return EXIT_USAGE; }

  let username;
  try { username = validateUsername(args.positional[0]); }
  catch (error) {
    if (!(error instanceof HttpError)) throw error;
    err(error.message);
    return EXIT_USAGE;
  }

  const config = databaseFromEnv(env);
  if (!config.ok) { reportConfigErrors(config.errors, err); return EXIT_USAGE; }
  const { database } = config;

  let password;
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
    if (password === null) password = await askNewPassword(promptHidden, err, { first: 'New password (12–128 characters): ', confirm: 'Confirm new password: ' });
    if (password === null) { err('Too many invalid attempts.'); return EXIT_FAIL; }

    try { await service.resetPassword(username, password); }
    catch (error) {
      if (error instanceof HttpError) { err(error.message); return EXIT_FAIL; }
      err(databaseError(database, error));
      return EXIT_FAIL;
    }
    out(`Password reset for ${username}. All existing sessions for this account have been signed out.`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof InputEnded) { err('Input ended; the password was not changed.'); return EXIT_FAIL; }
    err(databaseError(database, error));
    return EXIT_FAIL;
  } finally {
    await service.close();
  }
}

if (import.meta.main) process.exitCode = await runResetPassword();
