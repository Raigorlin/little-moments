// Smoke_Provisioner (Requirement 27; design.md Components §21.3): creates the Smoke_Test account (role member)
// and its Smoke_Fixture trip in the PostgreSQL database named by CAMPING_DATABASE_*, once per environment.
// In the App_Image this file is /app/tools/create-smoke-account.js (scripts/build-server.mjs). On the
// Deploy_Host only a Host_Operator runs it, through `lm-deploy <env> smoke-account <digest>`.
//
// It refuses when the database has no active administrator (create the first one with create-admin first),
// and when the account name belongs to an administrator or a disabled account. Running it again with the same
// arguments writes nothing: an existing member account and an existing fixture are kept unchanged. A new
// password for an existing account is set with reset-password.
//
// The password is read only from --password-file, a hidden terminal prompt (asked twice), or piped stdin
// (one line). It is never taken from arguments or environment variables, never printed, and never audited.
// stdout carries exactly one JSON line (the result); prompts and messages go to stderr.
// Exit codes: 0 done; 1 refused, invalid password or database failure; 2 usage or configuration error.
import { HttpError, SMOKE_DISPLAY_NAME, validateFixtureTitle, validateUsername } from '../server/accounts.js';
import {
  CliError, EXIT_FAIL, EXIT_OK, EXIT_USAGE, InputEnded, askHidden, askNewPassword, databaseError, databaseFromEnv,
  nonInteractivePassword, openAccountService, parseArgs, readStdin, reportConfigErrors
} from './account-cli.mjs';
import { SMOKE_FIXTURE_DATES } from './smoke.mjs';

export const DEFAULT_USERNAME = 'smoke-bot';
export const DEFAULT_FIXTURE = 'smoke-fixture';
export { SMOKE_DISPLAY_NAME, SMOKE_FIXTURE_DATES };

/** Every `reason` the failure JSON line can carry (lm-deploy embeds it in its own error line). */
export const REASONS = Object.freeze([
  'usage', 'config_invalid', 'password_invalid', 'input_ended', 'database', 'no_admin', 'account_is_admin', 'account_disabled'
]);
const REFUSALS = new Set(['no_admin', 'account_is_admin', 'account_disabled']);

export const USAGE = [
  'Usage: bun run create-smoke-account [--username <name>] [--fixture <title>] [--password-file <path>]',
  '       In the App_Image: bun /app/tools/create-smoke-account.js [options]',
  '',
  'Creates the Smoke_Test account (role member) and its Smoke_Fixture trip in the PostgreSQL database named by',
  'CAMPING_DATABASE_HOST, CAMPING_DATABASE_PORT, CAMPING_DATABASE_NAME, CAMPING_DATABASE_USER,',
  'CAMPING_DATABASE_PASSWORD and CAMPING_DATABASE_SSLMODE. The migrations must already be applied and the',
  'database must have an administrator (create it first with create-admin). An existing member account and an',
  'existing fixture are kept unchanged; it refuses when the name belongs to an administrator or a disabled account.',
  '',
  'The password is read from --password-file (the file holds the password on one line), otherwise',
  'from the terminal without echo (asked twice), otherwise from piped stdin (one line). It is never',
  'read from arguments or environment variables and never printed. It is not changed for an existing',
  'account; use reset-password for that.',
  '',
  'Options:',
  `  --username <name>       Account name (default ${DEFAULT_USERNAME}).`,
  `  --fixture <title>       Title of the Smoke_Fixture trip (default ${DEFAULT_FIXTURE}).`,
  '  --password-file <path>  Read the password from this file.',
  '  --help                  Show this message.',
  '',
  'Output: one JSON line on stdout. Exit codes: 0 done, 1 refused or failed, 2 usage or configuration error.'
].join('\n');

/** Hidden prompt on stderr, so stdout keeps exactly one JSON line. */
const promptOnStderr = question => askHidden(question, { stdout: process.stderr });

export async function runCreateSmokeAccount({
  argv = process.argv.slice(2),
  env = process.env,
  isTTY = process.stdin.isTTY === true,
  promptHidden = promptOnStderr,
  readInput = readStdin,
  out = console.log,
  err = console.error,
  openService = openAccountService,
  poolOptions = {}
} = {}) {
  const result = (code, line) => { out(JSON.stringify(line)); return code; };
  const failed = (code, reason) => result(code, { ok: false, reason });

  const args = parseArgs(argv, ['--username', '--fixture', '--password-file']);
  if (args?.help && argv.length === 1) { out(USAGE); return EXIT_OK; }
  if (!args || args.help || args.positional.length > 0) { err(USAGE); return failed(EXIT_USAGE, 'usage'); }

  let username, fixture;
  try {
    // Not trimmed: the stored values must be exactly what Smoke_Test sends and compares (Req 27.5).
    username = validateUsername(args.options['--username'] ?? DEFAULT_USERNAME);
    fixture = validateFixtureTitle(args.options['--fixture'] ?? DEFAULT_FIXTURE);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    err(error.message);
    return failed(EXIT_USAGE, 'usage');
  }

  const config = databaseFromEnv(env);
  if (!config.ok) { reportConfigErrors(config.errors, err); return failed(EXIT_USAGE, 'config_invalid'); }
  const { database } = config;

  let password;
  try {
    password = await nonInteractivePassword({ file: args.options['--password-file'], isTTY, readInput });
  } catch (error) {
    if (!(error instanceof CliError || error instanceof HttpError)) throw error;
    err(error.message);
    return failed(EXIT_FAIL, 'password_invalid');
  }

  let service;
  try { service = await openService(database, poolOptions); }
  catch (error) { err(databaseError(database, error)); return failed(EXIT_FAIL, 'database'); }
  try {
    if (password === null) password = await askNewPassword(promptHidden, err);
    if (password === null) { err('Too many invalid attempts.'); return failed(EXIT_FAIL, 'password_invalid'); }

    let done;
    try {
      done = await service.provisionSmokeAccount({ username, password, fixture, dates: SMOKE_FIXTURE_DATES });
    } catch (error) {
      if (error instanceof HttpError) {
        err(error.message);
        return failed(EXIT_FAIL, REFUSALS.has(error.reason) ? error.reason : 'database');
      }
      err(databaseError(database, error));
      return failed(EXIT_FAIL, 'database');
    }
    return result(EXIT_OK, { ok: true, username: done.username, account: done.account, fixture: done.fixture, fixtureStatus: done.fixtureStatus });
  } catch (error) {
    if (error instanceof InputEnded) { err('Input ended; nothing was created.'); return failed(EXIT_FAIL, 'input_ended'); }
    err(databaseError(database, error));
    return failed(EXIT_FAIL, 'database');
  } finally {
    await service.close();
  }
}

if (import.meta.main) process.exitCode = await runCreateSmokeAccount();
