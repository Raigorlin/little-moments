 Security Review

> **Merge note.** This review describes the `security-harden` branch before it was merged into main. Its SQLite database, nginx/published-mode and docker-compose deployment, and Bedrock-era content are superseded by the PostgreSQL data layer, the Jenkins/Deploy_Host deployment, and the OpenAI receipt AI described in the [README](../README.md). Tests named here for the removed SQLite database path guard (SR-12) no longer exist, and some test names changed in the merge.

Security review of the account version of 日子拾光 / Little Moments, written for the `security-hardening` spec (Requirement 24). The final report with the operator's 25-item table, test results, and operator steps is [docs/security-report.md](security-report.md).

Contents:

1. [Method](#method)
2. [Threat model](#threat-model)
3. [Summary of Findings](#summary-of-findings)
4. [Findings](#findings)
5. [OWASP Top 10 (2021)](#owasp-top-10-2021)
6. [Topic sections](#topic-sections) (invite tokens, first-admin setup, deployment configuration, service worker cache, request size and concurrency, prompt injection)
7. [CSRF_Decision](#csrf_decision)
8. [Admin trip access](#admin-trip-access)
9. [Form and field table](#form-and-field-table)
10. [HTML_Sink inventory](#html_sink-inventory)
11. [Environment variable table](#environment-variable-table)
12. [Password hash inspection](#password-hash-inspection)
13. [Checked with no Finding](#checked-with-no-finding)
14. [Dependency_Audit](#dependency_audit) (task 13.1)

## Method

| Item | Value |
| --- | --- |
| Date | 2026-11-09 (local time, UTC+08:00) |
| Reviewer | the coding agent implementing this spec |
| Code state | after tasks 1 to 13.1 of `.kiro/specs/security-hardening/tasks.md` |
| Platform | Windows, Bun 1.4.4 |
| Scope | everything in the repository: `server/`, `scripts/`, `src/`, `index.html`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore`, `package.json`, `bun.lock`, `docs/deploy-nginx.md`, `README.md` |
| Out of scope | the operator's real server, nginx, TLS certificates, the OpenAI account, and the remote git repository (operator actions, see the Security_Report) |

Files read line by line: `server/accounts.js`, `server/http.js`, `server/deploy-config.js`, `server/settings.js`, `server/receipt-ai.js`, `server/ai-cost.js`, `server/security-events.js`, `server/safe-log.js`, `server/ledger.js` (validation parts), `scripts/serve.mjs`, `scripts/build.mjs`, `scripts/create-admin.mjs`, `scripts/check-accounts.mjs`, `src/auth-paths.js`, `src/model.js` (escaping and `isValidState`), `src/maps.js`, `src/receipt-image.js`, `src/receipt-ai-client.js`, and the rendering and form code of `src/accounts-ui.js`, `src/app.js`, and `src/expenses-ui.js`.

Searches and commands run:

| Purpose | Command or search |
| --- | --- |
| HTML_Sink inventory (Req 9.9) | `Select-String -Path src/*.js -Pattern "innerHTML\|outerHTML\|insertAdjacentHTML\|document\.write"` |
| Environment variables (Req 14.1) | `Select-String` for `process.env`, `env.`, `env[`, and `CAMPING_` over `server/`, `scripts/`, `src/`, `Dockerfile`, `docker-compose.yml`, `package.json` |
| SQL construction (Req 7) | read every `db.query`/`db.exec` call in `server/`; automated by `tests/security-files.test.js` "every SQL call in server/ is a tagged template; no string-built queries and no unsafe()" |
| Password hash inspection (Req 2.8) | read-only Bun script, see [Password hash inspection](#password-hash-inspection) |
| Dependency_Audit (Req 21, 22) | `bun audit`, see [Dependency_Audit](#dependency_audit) |
| Secret scan | `bun scripts/scan-secrets.mjs` (result recorded in the Security_Report) |
| Unit_Suite and E2E_Suite | the commands in the Dependency_Audit "Test runs" table (930 unit tests passed; security e2e 8 of 8 passed) |

Severity follows Requirement 24.7. Status is one of Fixed, Already Mitigated, Accepted Risk, Operator Action, or Deferred (Requirement 24.4). Status evidence follows Requirement 24.8: Fixed names the verifying test, Already Mitigated names the file and line of the control (and the test that covers it, Requirement 25.3), Accepted Risk and Deferred give the reason and the condition for revisiting, and Operator Action points to a Security_Report step. Line numbers refer to the files as of the date above.

## Threat model

### Assets

| Asset | Where it lives |
| --- | --- |
| Accounts (username, display name, role, password hash) | `users` table in the Accounts_DB (`data/accounts.sqlite` by default) |
| Sessions | `sessions` table (SHA-256 of the token only); `ggc_session` cookie in the browser |
| Trip data | `trips.state_json`, `trip_members`, `invites` |
| Ledger data | `trip_ledgers` |
| Receipt images | browser memory and App_Server memory during one request; sent to OpenAI; never stored |
| OpenAI_Key | `.secrets/openai_api_key` or `CAMPING_OPENAI_API_KEY`, held in `createReceiptAi` memory |
| The Accounts_DB itself | the SQLite file plus `-wal` and `-shm` |

### Actors

| Actor | Description |
| --- | --- |
| Anonymous visitor | anyone who can reach nginx (Published_Mode) or the App_Server port (Local_Mode, LAN) |
| Member | signed-in user with `role = 'member'` |
| Trip_Participant | owner of a trip or a user with a `trip_members` row for it |
| Admin | signed-in user with `role = 'admin'` |
| Operator | person with shell access to the server, the Docker host, and the OpenAI account |

### Entry points

Route classes match the route inventory test `tests/security-auth.test.js` "the inventory lists exactly the Route_Table entries, and no entry is diagnostic". The Route_Table is `server/accounts.js:1396-1424`.

| Entry point | Reached by | Assets exposed |
| --- | --- | --- |
| `GET /api/session` | anyone | the caller's own public user fields, setup and registration flags |
| `POST /api/setup` (Local_Mode only) | loopback callers while no user exists | creates the first Admin |
| `POST /api/login` | anyone (rate-limited) | starts a Session; writes Failed_Login_Events |
| `POST /api/register` | anyone while registration is open (never in Published_Mode) | creates a Member |
| `POST /api/logout` | anyone | deletes the caller's Session |
| `GET /api/invites/{token}/preview` | anyone with a Valid_Invite token (rate-limited) | trip title, destination, dates, inviter display name |
| `POST /api/invites/{token}/register` | anyone with a Valid_Invite token (rate-limited) | creates a Member and joins one trip |
| `GET`, `POST /api/trips` | Member, Admin | own trips (Admin: all trips) |
| `GET`, `PUT`, `PATCH /api/trips/{id}`, `POST /api/trips/{id}/check` | Trip_Participant, Admin | trip state |
| `GET`, `PUT /api/trips/{id}/ledger` | Trip_Participant bound to a person | ledger data |
| `GET`, `POST /api/trips/{id}/receipt-ai` | Trip_Participant bound to a person, subject to the Receipt_AI_Policy | receipt AI status; sends an image to OpenAI using the OpenAI_Key |
| `GET`, `POST /api/trips/{id}/invites`, `POST /api/trips/{id}/invites/{inviteId}/revoke` | Trip_Participant (Inviter), Admin | Invite_List, new invite tokens |
| `POST /api/trips/{id}/delete` | trip owner, Admin | trip deletion |
| `GET /api/invites/{token}`, `POST /api/invites/{token}/join` | Member, Admin with a token | trip title and dates; joins the trip |
| `GET /api/admin/users`, `PATCH /api/admin/users/{id}`, `POST /api/admin/users/{id}/delete` | Admin | all accounts |
| `POST /api/admin/trips/{id}/delete` | Admin | any trip |
| `GET /api/admin/audit` | Admin | audit log (200 newest) |
| `GET`, `PATCH /api/admin/settings` | Admin | Receipt_AI_Policy |
| `GET /api/admin/receipt-ai-usage` | Admin | receipt AI counts and token totals |
| `GET /api/admin/security`, `POST /api/admin/security/alerts/{id}/acknowledge` | Admin | Failed_Login_Events, Security_Alerts |
| Static_Allowlist files (`server/http.js:35-36`) | anyone | the App_Shell bundle, styles, fonts, `sw.js`; no account data |
| Service worker (`sw.js`, written by `scripts/build.mjs:26-33`) | anyone's browser | cached App_Shell files only; never `/api/` responses |
| nginx (`docs/deploy-nginx.md`) | anyone on the internet | TLS termination and proxy to `127.0.0.1:5173`; no files from disk |
| Docker image (`Dockerfile`, `docker-compose.yml`) | operator; LAN clients of the published port | the runtime image holds `dist/`, `server/`, `src/`, `scripts/serve.mjs`, production `node_modules`; the key arrives as a Docker secret file |

## Summary of Findings

61 Findings. Counts are by the tables in [Findings](#findings).

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 17 |
| Info | 39 |

| Status | Count |
| --- | --- |
| Fixed | 19 |
| Already Mitigated | 23 |
| Accepted Risk | 11 |
| Operator Action | 2 |
| Deferred | 6 |

The only High Finding (SR-02) is Fixed. No Critical or High Finding is Accepted Risk or Deferred (Requirement 24.6).

## Findings

Each Finding gives the location, evidence, impact, recommendation, and status. Tests are named by file and test title.

### Gaps from the requirements Introduction (Requirement 24.5)

#### SR-01 Failed logins were not recorded and raised no alert

- **Severity:** Low (missing detection control; no direct attack path).
- **Location:** `server/accounts.js:858-900` (`routes.login`), `server/security-events.js:42` (`evaluateAlerts`), `:89` (`createAlertDispatcher`), `:168` (`createSecurityEventStore`), `:260` (`recordFailedLogin`); admin routes `server/accounts.js:1353`, `:1368`; Admin_Page `src/accounts-ui.js:683-700`.
- **Evidence:** before the fix only successful logins wrote an `audit` row. Now every login that starts no Session writes one Failed_Login_Event with reason `invalid_input`, `rate_limited` (once per blocked key per window), `deleted_account`, or `bad_credentials`, in the `security_events` table, separate from `audit`. Alerts fire at 5 failures per username or 20 overall in 900 s with a 15-minute cooldown and pass through one Alert_Dispatcher.
- **Impact:** without it, a password-guessing run left no trace for the Admin.
- **Recommendation:** done. A LINE notifier can attach through `registerAlertNotifier` (`server/accounts.js:1468`).
- **Status:** Fixed. Tests: `tests/security-events.test.js` "Property 28: each failed login is classified once without secrets", "Property 29: alerts follow thresholds and cooldowns", "Property 30: notifiers cannot affect alert storage or each other", "throwing and never-resolving notifiers do not change the login response or block a later notifier", "acknowledging an alert marks it, writes one audit row, and lowers the count"; `tests/security-pages.e2e.js` "admin page shows receipt AI usage and a failed-login alert banner that acknowledgment lowers and hides".

#### SR-02 Receipt AI limits reset on restart, used a rolling day, had no monthly cap, and recorded no tokens

- **Severity:** High (a Member could cause OpenAI requests beyond the AI_Cost_Config monthly limit: 100 per rolling 24 hours allowed about 3000 per month against the 1000 limit, and every restart reset the counters).
- **Location:** `server/accounts.js:570-588` (`reserveAiCall`), `:590-595` (`settleAiCall`), `:1272-1286` (call site); `server/ai-cost.js:113` (`quotaDecision`); schema `receipt_ai_usage`.
- **Evidence:** the per-user (rolling 15 minutes), UTC day, and UTC month counts now come from `receipt_ai_usage` rows. The count check and the `pending` row insert run in one `BEGIN IMMEDIATE` transaction. Each OpenAI call ends with exactly one row settled to `success`, `error`, or `timeout` with token counts. A database failure returns 503 and makes no OpenAI call.
- **Impact:** unbounded monthly spend before the fix.
- **Recommendation:** done. The operator should also set a budget in the OpenAI dashboard (Security_Report, operator actions).
- **Status:** Fixed. Tests: `tests/receipt-ai-cost.test.js` "Property 23: receipt AI calls follow the persistent quota model", "Property 24: each OpenAI call leaves exactly one usage record", "counts survive closing and reopening the database", "503 without a provider call when the usage table cannot be read or written", "admin usage route totals the current UTC day and month and shows the limits".

#### SR-03 Model settings were fixed in code, and an invalid model ID silently disabled receipt AI

- **Severity:** Low.
- **Location:** `server/ai-cost.js:72-86` (`parseAiCostConfig`), `scripts/serve.mjs:11-12`, `server/receipt-ai.js:94-96`.
- **Evidence:** `CAMPING_OPENAI_MODEL_ID`, `CAMPING_OPENAI_IMAGE_DETAIL`, `CAMPING_OPENAI_MAX_COMPLETION_TOKENS`, `CAMPING_RECEIPT_AI_USER_LIMIT`, `CAMPING_RECEIPT_AI_DAILY_LIMIT`, and `CAMPING_RECEIPT_AI_MONTHLY_LIMIT` are validated at startup and throw a `ConfigError`, so `serve.mjs` prints `Configuration error: …` and exits 1. The values reach the OpenAI request body.
- **Impact:** a typo could turn the feature off without notice, and cost settings could not be lowered without a code change.
- **Recommendation:** done.
- **Status:** Fixed. Tests: `tests/ai-cost.test.js` "Property 22: one invalid setting throws a ConfigError naming it; valid settings round-trip", "empty environment gives the Requirement 18.1 defaults"; `tests/receipt-ai-cost.test.js` "configured model, detail, and token cap reach the OpenAI request body; one call, no retry".

#### SR-04 Content-Security-Policy and framing headers were weaker than required

- **Severity:** Low (`frame-ancestors 'self'` already blocked cross-site framing; the rest is defense in depth).
- **Location:** `server/http.js:4-9`.
- **Evidence:** the CSP had `frame-ancestors 'self'`, kept `'wasm-unsafe-eval'`, and had no `object-src 'none'`; `X-Frame-Options` was `SAMEORIGIN`; `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` were missing. All are now set on every response.
- **Impact:** same-origin framing and plugin content were allowed; WebAssembly compilation was allowed for code no longer used.
- **Recommendation:** done.
- **Status:** Fixed. Tests: `tests/security-headers.test.js` "SECURITY_HEADERS holds exactly the expected values", "directives match Requirements 9.10, 9.11, 11.2, 11.3, and 13.8", "Property 17: every response carries the security headers exactly once".

#### SR-05 429 responses had no Retry-After

- **Severity:** Info.
- **Location:** `server/accounts.js:269-272` (`RateLimiter.retryAfter`), `:563` (`limited`), `:837`, `:884-886`, `:1087`, `:1132`.
- **Evidence:** every Rate_Limiter 429 now carries `Retry-After` in whole seconds, at least 1; body and status unchanged.
- **Impact:** clients could not tell when to retry.
- **Status:** Fixed. Tests: `tests/security-auth.test.js` "Property 6: Retry-After matches the remaining window", "loginUser: 5 counted failures lock the username for any client and any password, with Retry-After", "loginClient: 30 counted failures lock the Client_Address for every username, with Retry-After", "register: 20 attempts per Client_Address across both registration routes, with Retry-After", "invitePreview: 60 lookups per Client_Address, with Retry-After".

#### SR-06 No Sec-Fetch-Site check

- **Severity:** Low (the exact Origin check already blocked cross-site requests).
- **Location:** `server/accounts.js:1447`.
- **Evidence:** a Mutating_Request with `Sec-Fetch-Site: cross-site` now gets 403 `不接受跨站請求。` before any handler runs, even with a matching Origin.
- **Status:** Fixed. Tests: `tests/security-csrf.test.js` "Property 15: the CSRF gate follows its decision table" and the per-route CSRF matrix (Req 10.7).

#### SR-07 JSON handlers checked the session before the content type

- **Severity:** Info.
- **Location:** `server/accounts.js:62-65` (`requireJsonType`), called first in each JSON_Route handler (for example `:915`, `:947`, `:1047`, `:1165`).
- **Evidence:** a JSON_Route with a non-JSON content type now gets 415 before 401, after only the PBN pre-checks. See SR-51 for the one ordering kept from PBN.
- **Status:** Fixed. Test: `tests/security-csrf.test.js` "a JSON_Route without a session and with text/plain gets 415, not 401 (Req 10.3, 10.4)".

#### SR-08 OPTIONS to an unknown API path returned 404

- **Severity:** Info.
- **Location:** `server/accounts.js:1433`.
- **Evidence:** every `OPTIONS` to `/api/…` now returns 405 before route matching, with no handler, no cookie, and no `Access-Control-*` header.
- **Status:** Fixed. Tests: `tests/security-csrf.test.js` "Property 18: OPTIONS on the API is always 405 and inert", "OPTIONS with a foreign Origin and Access-Control-Request-Method: POST gets 405 and nothing else".

#### SR-09 The Escape_Function did not escape the backtick

- **Severity:** Low (attribute values are double-quoted, so no known injection path).
- **Location:** `src/model.js:12`.
- **Evidence:** `escape` now maps `` ` `` to `&#96;`.
- **Status:** Fixed. Tests: `tests/model.test.js` "escapes backticks"; `tests/security-client.test.js` "Property 13: escape removes markup characters and decodes back to the input".

#### SR-10 Login return paths covered only invite pages

- **Severity:** Info.
- **Location:** `src/auth-paths.js:7-11`; callers `src/accounts-ui.js:134-137` (`expireToLogin`), `:466`, `:621`, `:819`.
- **Evidence:** `safeNext` accepts exactly the Private_Page patterns; signed-out visitors of home, trip, and admin go to `/login?next=…`; a 401 while loading a Private_Page clears `#app` and redirects.
- **Status:** Fixed. Tests: `tests/security-client.test.js` "Property 2: safeNext accepts exactly Private_Page paths and loginPath round-trips them"; `tests/security-pages.e2e.js` "signed-out home, trip and admin pages redirect to login with next and return after sign-in".

#### SR-11 Uncaught API errors left no log line

- **Severity:** Low.
- **Location:** `server/safe-log.js:39-46`, `server/accounts.js:1455-1458`, `server/http.js:44`.
- **Evidence:** an uncaught error now writes one line with time, method, query-free path, and a sanitized error name, and returns the fixed generic body. See SR-46 for the path content.
- **Status:** Fixed. Test: `tests/security-files.test.js` "Property 25: uncaught errors give the generic body and one safe log line".

#### SR-12 The database path guard did not resolve symlinks or check the configured Build_Output

- **Severity:** Medium (needs an operator misconfiguration, which is outside the attacker's control).
- **Location:** `server/accounts.js:84-118` (`isPublicDbPath`, `assertPrivateDbPath`), `:400`; `scripts/serve.mjs:15-18`.
- **Evidence:** the guard now resolves the nearest existing ancestor with `realpath`, compares both forms with `dist`/`public` segments and with `CAMPING_DIST`, and runs before `new Database(...)`.
- **Impact:** a `CAMPING_DB` inside the served directory, directly or through a symlink, would have exposed the database for download.
- **Status:** Fixed. Tests: `tests/security-files.test.js` "Property 27: isPublicDbPath matches the reference model", "Property 27: createAccountService refuses exactly the public paths and creates nothing", "a symlink or junction into the Build_Output or a dist directory is refused", "scripts/serve.mjs exits 1 before listening for a Build_Output path and a public path (Req 20.9)".

#### SR-13 The local-handbook import accepted files up to 2,000,000 bytes

- **Severity:** Low.
- **Location:** `src/app.js:406`.
- **Evidence:** the import now refuses files over 1,048,576 bytes before `file.text()` with `請選擇不超過 1 MiB 的備份檔。`.
- **Status:** Fixed. Test: `tests/security-pages.e2e.js` "local planner import refuses a backup file over 1 MiB without changing the handbook".

#### SR-14 `.dockerignore` did not exclude `.kiro`

- **Severity:** Low (`.kiro/` holds specs, no secrets; the runtime stage never copied it).
- **Location:** `.dockerignore:2`.
- **Status:** Fixed. Test: `tests/security-config.test.js` ".dockerignore excludes every required entry (Req 20.5)".

#### SR-15 The Example_Nginx_Config had no rule for dot-prefixed paths

- **Severity:** Low (the App_Server serves only allowlisted paths; this is a second layer).
- **Location:** `docs/deploy-nginx.md:397-398`.
- **Evidence:** `location ~ /\.(?!well-known/) { return 404; }` sits before `location /` (line 400) in the `www` server block; ACME challenges stay reachable.
- **Status:** Fixed. Test: `tests/security-config.test.js` "dot-prefixed segments return 404 except /.well-known/, before location / (Req 20.8)".

#### SR-16 Unused browser OCR path shipped Tesseract and needed `'wasm-unsafe-eval'`

- **Severity:** Low (unused code with a third-party dependency and a weaker CSP).
- **Location:** `package.json`, `bun.lock`, `scripts/build.mjs`, `src/receipt-image.js` (helpers moved from the deleted `src/receipt-ocr.js`), `server/http.js:5`.
- **Evidence:** see the [Dependency_Audit](#dependency_audit) "Browser OCR path" table.
- **Status:** Fixed. Tests: `tests/security-files.test.js` "no maps, no forbidden files, no OCR, no PUBLISHED flag, and no canary from the environment (Req 13.3, 14.3, 14.4, 19.4, 19.9, 20.4)"; `tests/ocr-assets.e2e.js` "browser OCR assets are gone, CSP has no wasm-unsafe-eval, photos have no public upload route".

#### SR-17 Obsolete Bedrock region, model, and key variables in the e2e runner

- **Severity:** Info.
- **Location:** `scripts/check-accounts.mjs:10` (the server environment now sets only `PORT` and `CAMPING_DB`).
- **Status:** Fixed. Test: `tests/security-config.test.js` "no obsolete Bedrock variable is referenced outside .kiro/, node_modules/, and the Build_Output (Req 22.6)".

#### SR-18 Git history could not be scanned from this workspace

- **Severity:** Medium (if a key was ever committed, anyone with access to the remote repository could read it; whether that happened is unknown).
- **Location:** workspace root; it is not a git work tree.
- **Evidence:** `scripts/scan-secrets.mjs` scans files only here and prints the history command for the real clone (`tests/secret-scan.test.js` "non-repository directory prints the history notice and command without changing the exit code").
- **Recommendation:** run `bun scripts/scan-secrets.mjs` inside the real clone; revoke any key it reports.
- **Status:** Operator Action. See the Security_Report, operator actions: key revocation and git history rewrite.

#### SR-19 No security review or report existed

- **Severity:** Info.
- **Location:** `docs/security-review.md` (this file), `docs/security-report.md`.
- **Status:** Fixed. These are documents, so no automated test fails without them; task 13.3 links both from `README.md` (Requirement 26.12).

#### SR-20 A corrupt stored password hash could throw during login

- **Severity:** Low.
- **Location:** `server/accounts.js:127-139` (`verifyPassword`).
- **Evidence:** scrypt with impossible parameters threw inside `verifyPassword`, giving a 500 instead of the wrong-password 401. The function now catches and returns `false`.
- **Status:** Fixed. Tests: `tests/security-auth.test.js` "Property 5: malformed stored hashes fail closed", "a corrupt stored hash gives the wrong-password response and later requests still work".

### Controls already in place (Already Mitigated)

| ID | Title | Severity | Control (file:line) | Test |
| --- | --- | --- | --- | --- |
| SR-21 | Passwords stored as scrypt (N=16384, r=8, p=1, 16-byte salt, 64-byte key) with a constant-time compare; one dummy hash for unknown or deleted users; 12 to 128 code points | Info | `server/accounts.js:21`, `:121-125`, `:135`, `:146-151`, `:889-890` | `tests/security-auth.test.js` "every user creation path stores scrypt$N$8$1$salt$hash, including the Create_Admin_CLI", "Property 3: password length rule is exact", "Property 4: password hashing round trip with unique salts", "unknown and deleted users run one dummy scrypt; blocked logins run none and count nothing", "a Canary_Secret password never appears in the database, WAL, audit, logs, or responses" |
| SR-22 | 32-byte session tokens stored as SHA-256; cookie `HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, `Secure` for proxied Published_Mode or `https:`; session replaced on login, registration, invite registration, and setup; logout clears | Info | `server/accounts.js:47-48`, `:529`, `:552-560`, `:902-906` | `tests/security-auth.test.js` "login sets HttpOnly, SameSite=Strict, Path=/, Max-Age 604800, no Domain, and a matching expiry", "the raw session token is stored only as its SHA-256 hash and never in the audit log or body", "logout with a session deletes it and sends a cleared cookie with the same attributes", "logout without a Valid_Session succeeds, clears the cookie, and deletes no other Session", the four "session replacement (Req 3.8, 3.9)" tests; `tests/deploy-config.test.js` Property 5 |
| SR-23 | Expired, unknown, malformed, and soft-deleted sessions are treated as signed out | Info | `server/accounts.js:436`, `:530-543` | `tests/security-auth.test.js` "Property 1: every unusable session is rejected on every protected route" |
| SR-24 | Login limits per username (5/15 min) and per Client_Address (30/15 min); `register` 20/hour shared by both registration routes; `invitePreview` 60/15 min; closed registration answers 403 before the limiter | Info | `server/accounts.js:33-38`, `:835-838`, `:879-897`, `:1086-1088`, `:1130-1133` | `tests/security-auth.test.js` "loginUser: …", "loginClient: …", "register: …", "a successful login resets the username count and leaves the client count (Req 4.9)"; `tests/publish.test.js` Property 9 (line 340) and "Published_Mode refuses valid, malformed, and empty bodies without spending the register bucket" |
| SR-25 | Admin role and deletion state read from the Accounts_DB on every Admin_API request | Info | `server/accounts.js:544-545` | `tests/security-auth.test.js` "Property 7: admin routes refuse Members and signed-out callers without side effects", "matrix: Admin gets through, Member gets 403, no session gets 401, and refusals change nothing", "a demotion applies to the next admin request of the demoted account" |
| SR-26 | Trip isolation: outsiders get the same 404 as a missing trip; trip lists by membership; ledger and receipt AI require a bound person, also for Admins | Info | `server/accounts.js:447`, `:628-634`, `:703-708`, `:908-911` | `tests/security-access.test.js` "every Trip_Scoped_Route answers an outsider exactly like a nonexistent trip", "GET /api/trips returns exactly the live trips a Member takes part in, and every live trip for an Admin", "an Admin outside the trip manages it but gets 404 on Participant_Only_Routes", "an outsider can neither read nor overwrite a real ledger" |
| SR-27 | Every SQL statement uses `?` placeholders; SQL text is built only from literals and the constants `TRIP_SELECT` and `LIVE` | Info | `server/accounts.js:424-523`, `server/security-events.js:168-200`, `server/ledger.js` | `tests/security-files.test.js` "every SQL call in server/ is a tagged template; no string-built queries and no unsafe()", "the check fails on interpolated parameters and passes on constants"; `tests/security-access.test.js` "SQL payloads in login are wrong credentials and start no Session", "SQL payloads as invite tokens and trip IDs match no row", "SQL payloads in a display name are stored as data", "trip text and ledger text come back byte-identical and no other row changes" |
| SR-28 | Server-side validation: JSON only, 1 MiB body, object body, per-field type and length checks, `cleanState` drops unknown fields, `validateLedgerBody` rejects unknown keys | Info | `server/accounts.js:158-189`, `:602-621`; `server/ledger.js:10`, `:174-177`; `src/model.js:88-100` | `tests/security-access.test.js` "random JSON bodies give a status below 500 and leave every table unchanged on 4xx", "PUT /api/trips/{id} drops unknown fields at every level and keeps schema fields unchanged", "boundary cases on every mutating JSON route are rejected with 400–422 and change nothing" |
| SR-29 | Exact Origin match against the Expected_Origin for every Mutating_Request; `SameSite=Strict` cookie | Info | `server/accounts.js:1446`, `:529` | `tests/publish.test.js` Property 6 (line 308); `tests/security-csrf.test.js` per-route CSRF matrix |
| SR-30 | No CORS: no `Access-Control-*` header on any response | Info | `server/http.js:4-9` (no such header in the code) | `tests/security-headers.test.js` "no Access-Control-* header (Requirements 12.2, 12.7)" cases |
| SR-31 | OpenAI_Key read only on the server, sent only to `https://api.openai.com` with `redirect: 'error'`; OpenAI errors and bodies never forwarded; 55 s timeout; 256 KiB response cap | Info | `server/receipt-ai.js:9-10`, `:97-104`, `:115-131` | `tests/security-files.test.js` "a canary key never reaches responses, logs, or the database (Req 13.2, 13.4, 13.5, 13.6)", "a rotated key file is used by the next createReceiptAi (Req 13.1, 16.7)", "src/ has no OpenAI host and no key variable read (Req 13.9)" |
| SR-32 | Receipt uploads: JPEG/PNG only with matching signature, ≤ 3.5 MiB, ≤ 8000 px per side, ≤ 20,000,000 px, complete file; `maxRequestBodySize` 4 MiB | Info | `server/receipt-ai.js:42-50`; `server/accounts.js:1262-1271`; `scripts/serve.mjs:19` | `tests/receipt-image.test.js` "Property 21: receipt image validation accepts exactly complete images", "size boundary: exactly 3.5 MiB passes the size check, one byte more is 413", "dimension boundaries: 8000 px per side and 20,000,000 px"; `tests/security-config.test.js` "Bun.serve maxRequestBodySize is at most 4,194,304 bytes (Req 17.7)" |
| SR-33 | Static files served only from an allowlist inside the Build_Output; traversal refused; no sensitive file in the build or the runtime image; `.gitignore` entries | Info | `server/http.js:33-39`; `Dockerfile:18-22`; `.gitignore:4`, `:11-28` | `tests/security-files.test.js` "sensitive paths and case variants return 404 or 403 with no file bytes (Req 20.1)", "non-allowlisted paths get the same status whether or not a file exists (Req 20.2)", "Property 26: traversal never escapes the Build_Output"; `tests/security-config.test.js` "the runtime stage copies only the allowed paths and never the whole context (Req 20.6)", ".gitignore excludes every required entry (Req 20.7)" |
| SR-34 | No debug output: no inspector, hot reload, or watch flags; no diagnostic routes; no source maps | Info | `package.json:10`; `Dockerfile:25`; `scripts/build.mjs:7` | `tests/security-config.test.js` "the start script runs Bun without inspector, hot reload, or watch flags (Req 19.5)", "CMD starts Bun without inspector, hot reload, or watch flags (Req 19.5)"; `tests/security-auth.test.js` "the inventory lists exactly the Route_Table entries, and no entry is diagnostic" |
| SR-35 | Published_Mode controls: Startup_Validator, Host allowlist, Client_Address from Trusted_Proxies, no web setup, locked registration, `/demo` and `/setup` 404 | Info | `server/deploy-config.js:96-126`, `:177-235`; `server/accounts.js:404`, `:1399`; `server/http.js:34` | `tests/deploy-config.test.js` Properties 1 to 5, 7, and 8; `tests/security-headers.test.js` "Published_Mode /demo, /setup, and POST /api/setup are 404 with the headers"; `tests/http.test.js` "apex hostname is rejected in Published_Mode before reaching the account service" |
| SR-36 | Invite tokens: 32 random bytes, stored hashed, 7-day expiry, single use, identical 404 for every unusable token, preview limited to five fields, list and revoke by Invite_ID | Info | `server/accounts.js:18`, `:762-779`, `:1046-1158` | `tests/invites.test.js` Properties 12 to 15; `tests/invite-list.test.js` Properties 16 and 17; `tests/publish.test.js` Property 11 (line 655) |
| SR-37 | Receipt AI order: policy before image reading and before the quota; policy re-check after the call; one call per request, no retry; 1 per user and 2 overall in flight | Info | `server/accounts.js:1241-1289`; `server/settings.js:21` | `tests/receipt-ai-cost.test.js` "policy off and admins refuse before the quota and change no count", "a policy change during the call refuses the result but keeps the usage row", "configured model, detail, and token cap reach the OpenAI request body; one call, no retry"; `tests/settings.test.js` Property 10 |
| SR-38 | Service worker never caches `/api/` responses; navigations fall back only to the cached shell | Info | `scripts/build.mjs:32` | `tests/build-sw.test.js` "starts with exactly one PUBLISHED=false flag, has the /demo guard and mode-dependent cache name", "Published_Mode worker leaves /demo navigations to the network but handles /login"; `tests/http.test.js` "protected API response never falls back to shell or cache" |
| SR-39 | No secret in the build or in Docker metadata; compose passes the key as a mounted secret file | Info | `Dockerfile:12-16`; `docker-compose.yml:8-9`, `:16-18`; `scripts/build.mjs` (no `define`) | `tests/security-config.test.js` "ENV, ARG, and LABEL set no secret value (Req 14.5)", "provides the OpenAI key only as a mounted secret file (Req 14.6)", "Dockerfile, docker-compose.yml, and .env.example match no Secret_Scanner rule (Req 14.9, 14.10)"; `tests/security-files.test.js` fresh-build canary test |
| SR-40 | User_Content escaped before every HTML_Sink; map links only to the fixed Google Maps URL | Info | `src/model.js:12`; `src/maps.js:3-15`; see [HTML_Sink inventory](#html_sink-inventory) | `tests/security-xss.e2e.js` (all four tests); `tests/security-client.test.js` "Property 14: mapLink only links to the fixed Google Maps search URL" |
| SR-41 | A failed session check shows 暫時無法確認登入狀態 with a reload action and renders no account data | Info | `src/accounts-ui.js:802-807` | none found; see SR-57 |
| SR-42 | Example_Nginx_Config: HSTS `max-age=15552000`, `client_max_body_size 4m`, no `Access-Control-*` header, no `OPTIONS` handling, everything proxied | Info | `docs/deploy-nginx.md:374`, `:392`, `:395`, `:400` | `tests/security-config.test.js` "HSTS max-age=15552000 on the www block and on every HSTS header (Req 11.6)", "client_max_body_size is set to 4 MiB or less (Req 17.11)", "no add_header sets an Access-Control-* header (Req 12.6)", "nginx does not answer OPTIONS requests itself (Req 12.6)", "every request goes to the App_Server and no file is served from disk (Req 20.8)" |
| SR-43 | Prompt injection through receipt images is contained | Low | `server/receipt-ai.js:52-79`, `:81`, `:121` | `tests/receipt-ai.test.js` "normalizer uses only extracted exact amounts and allowed categories; sums independently", "uncertain or total rows never become ready amounts; no numeric guessing" |

SR-43 details are in [Prompt injection through receipt images](#prompt-injection-through-receipt-images).

### Findings outside the operator's list and observations

#### SR-44 The Rate_Limiter can be made to forget a username lockout

- **Severity:** Medium (needs control of many Client_Addresses).
- **Location:** `server/accounts.js:247-266` (`RateLimiter`, capacity 10,000 entries).
- **Evidence:** when the map is full, `hit()` first removes expired entries, then removes the oldest entries in insertion order, including entries that are still blocking. An attacker who locks a username (5 failures) and then creates about 10,000 new keys (failed logins with distinct usernames, each limited to 30 per Client_Address, so about 334 addresses within 15 minutes) evicts the lock and can guess again. Each guess still costs one scrypt run, and passwords have at least 12 characters.
- **Impact:** weakens the per-username guessing limit for a distributed attacker.
- **Recommendation:** evict only entries that are not currently blocking (or refuse new keys when only blocking entries remain), or keep the per-username lock in the Accounts_DB.
- **Status:** Deferred. Not in the spec's task list and this task changes only documents. Revisit before publishing the site at `https://www.our-littlemoments.com`.

#### SR-45 Docker local-only first-admin setup trusts a loopback Host header from the container network

- **Severity:** Medium (needs a fresh installation with no Admin yet and network access to the published port).
- **Location:** `server/accounts.js:284-289` (`isLoopback` with `allowLoopbackHostFromContainer`), `scripts/serve.mjs:17`, `Dockerfile:14`, `docker-compose.yml:5` (default bind `0.0.0.0`).
- **Evidence:** with `CAMPING_DOCKER_LOCAL_ONLY=1`, `POST /api/setup` accepts any peer whose request names `127.0.0.1`, `localhost`, or `[::1]` as Host, because Docker hides the real peer address. A LAN device can send that Host header while no user exists and create the first Admin.
- **Impact:** a LAN attacker could take over a fresh Docker installation before the operator finishes setup.
- **Recommendation:** keep following `README.md:151` (create the administrator on the host before allowing LAN access), or bind compose to `127.0.0.1` until setup is done.
- **Status:** Accepted Risk. The PBN spec (its Requirement 1.3) requires this Docker behavior to stay as it was, `README.md:151` documents the order, and Published_Mode refuses `CAMPING_DOCKER_LOCAL_ONLY=1` (`server/deploy-config.js:182-185`). Revisit if the Docker setup is used on an untrusted network.

#### SR-46 The error log line can contain an invite token

- **Severity:** Low (only someone who can read the server log sees it; tokens are single-use and expire in 7 days).
- **Location:** `server/safe-log.js:30-41` (`pathOf` keeps the whole pathname).
- **Evidence:** an uncaught error on `/api/invites/{token}/…` or `/invite/{token}` writes the 64-hex token as part of the path. Requirement 19.3 asks the line to leave out invite tokens.
- **Recommendation:** replace path segments that match `^[a-f0-9]{32,128}$` with `[token]` in `pathOf`, and extend Property 25 with a token in the path.
- **Status:** Deferred. This task changes only documents. Revisit with the next change to `server/safe-log.js`.

#### SR-47 nginx access logs record invite URLs

- **Severity:** Low.
- **Location:** `docs/deploy-nginx.md` (no `access_log` or `log_format` directive, so nginx logs the full request line by default).
- **Evidence:** `/invite/{token}` and `/api/invites/{token}/…` paths reach the operator's nginx access log. `Referrer-Policy: no-referrer` keeps them out of third-party referrers.
- **Recommendation:** restrict access to the logs and keep a short retention, or use a `log_format` that strips invite paths.
- **Status:** Operator Action. See the Security_Report, operator actions: nginx deployment.

#### SR-48 Registration reveals whether a username exists

- **Severity:** Low.
- **Location:** `server/accounts.js:846`, `:1142` (409 `這個帳號名稱已被使用。`).
- **Evidence:** registration needs a Valid_Invite in Published_Mode and is limited to 20 attempts per hour per Client_Address. Login does not reveal usernames (same 401 and a dummy hash).
- **Status:** Accepted Risk. A username picker must say when a name is taken. Revisit if open registration is ever allowed in Published_Mode.

#### SR-49 `'unsafe-inline'` remains in `style-src`

- **Severity:** Low.
- **Location:** `server/http.js:5`; needed by `style` attributes written by `src/art.js` and `src/dish-art.js`.
- **Evidence:** `script-src` is `'self'` only, so inline styles cannot run script. The remaining risk is CSS-based tricks if markup injection were ever found.
- **Status:** Accepted Risk. Revisit when the SVG art moves to classes (Requirement 11.7 report entry).

#### SR-50 Login and registration limits are held in memory

- **Severity:** Low.
- **Location:** `server/accounts.js:247`, `:414`.
- **Evidence:** a restart resets the `loginUser`, `loginClient`, `register`, and `invitePreview` counters. Receipt AI counts are persistent (SR-02).
- **Status:** Accepted Risk. An attacker cannot restart the server. Revisit if the App_Server runs as more than one process.

#### SR-51 `POST /api/register` answers 409 before 415 while no Admin exists

- **Severity:** Info.
- **Location:** `server/accounts.js:839-842`.
- **Evidence:** the design table put `requireJsonType` before `needsSetup`. The code keeps `needsSetup` first because the shipped PBN register-bucket property expects 409 for a body-less request before setup. No account and no session exist in that state.
- **Status:** Accepted Risk. Test: `tests/security-csrf.test.js` "before the first admin exists, a body-less POST /api/register gets 409, not 415". Revisit if the PBN test changes.

#### SR-52 Rejected logins write a Failed_Login_Event, which conflicts with "4xx leaves the database unchanged"

- **Severity:** Info.
- **Location:** `server/accounts.js:870-877`; `tests/security-access.test.js:74-78`; `tests/security-csrf.test.js:100-109`.
- **Evidence:** Requirements 8.2 and 8.5 ask that a 400 or 415 leaves every table unchanged; Requirement 23.1 asks that the same login requests write an `invalid_input` event. The tests leave out `security_events` and `security_alerts` from the unchanged-DB comparison for `POST /api/login` only.
- **Status:** Accepted Risk (the event table is the intended side effect). Revisit if the requirements are reworded.

#### SR-53 A malformed percent-encoded API path segment gets 400 before the session check

- **Severity:** Info.
- **Location:** `server/accounts.js:1448-1449`.
- **Evidence:** `/api/trips/%E0` returns 400 `網址格式不正確。` to signed-out and Member callers instead of 401 or 403. No data is returned and nothing changes.
- **Status:** Accepted Risk. Revisit if a route ever returns data before parameter decoding.

#### SR-54 `scripts/check-accounts.mjs` imports an undeclared package

- **Severity:** Info.
- **Location:** `scripts/check-accounts.mjs:5` imports `playwright`, which is only a dependency of `@playwright/test`.
- **Status:** Deferred. Test tooling only. Revisit when `@playwright/test` is upgraded.

#### SR-55 Stale build output directories in the workspace

- **Severity:** Info.
- **Location:** `.tmp-e2e-dist/` (includes `assets/ocr/` from before task 2) and `tmp-menu-check/`.
- **Evidence:** neither is served by default (the App_Server serves `CAMPING_DIST`, default `dist`). Neither name is listed in `.gitignore` or `.dockerignore`, so they would be committed or sent to the Docker build stage (not the runtime stage). They hold only built App_Shell files.
- **Recommendation:** delete both directories, or add them to `.gitignore` and `.dockerignore`.
- **Status:** Deferred. The agent does not delete files it did not create in this task. Revisit at the next cleanup.

#### SR-56 Pre-existing e2e failures unrelated to security

- **Severity:** Info.
- **Location:** listed under "Baseline e2e failures" in `docs/security-report.md`.
- **Evidence:** eight PBN-set failures (brand copy, receipt result copy, a home-card timeout, and two `register` 429s from the shared limit) failed before this spec and fail the same way now.
- **Status:** Deferred. Not security behavior. Revisit when the brand and receipt UI copy is settled.

#### SR-57 No automated test for the failed-session-check page

- **Severity:** Info.
- **Location:** `src/accounts-ui.js:802-807` (control in place, SR-41).
- **Evidence:** a search for 暫時無法確認登入狀態 in `tests/` finds no test. Requirement 1.11 asked for a test only.
- **Recommendation:** add an e2e case that makes `GET /api/session` fail with `page.route` and checks the message, the reload button, and an empty account area.
- **Status:** Deferred. This task changes only documents.

#### SR-58 `CAMPING_OPENAI_API_KEY_FILE` is a secret variable by Requirement 14.2 but the image sets it

- **Severity:** Info.
- **Location:** `Dockerfile:16`.
- **Evidence:** Requirement 14.2 marks a path to a key file as secret, Requirement 14.5 forbids secret values in `ENV`, and Requirement 14.6 requires the container path in this variable. The value `/run/secrets/openai_api_key` is the fixed Docker secret mount point and reveals nothing. `tests/security-config.test.js:140` allows exactly `_FILE` variables under `/run/secrets/`.
- **Status:** Accepted Risk. Revisit if the path ever points to a file inside the image.

#### SR-59 Some format-restricted server values reach `href` without the Escape_Function

- **Severity:** Info.
- **Location:** `src/app.js:461` (`accountTripPath`), used at `src/app.js:492`.
- **Evidence:** the path is built from the account username (server-validated as `^[a-z][a-z0-9-]{2,31}$`) and the trip ID (server-generated UUID). Neither is User_Content, and neither can hold a quote or angle bracket.
- **Recommendation:** wrap the value in `e()` the next time this code changes.
- **Status:** Accepted Risk.

#### SR-60 No second factor and no breached-password check

- **Severity:** Info.
- **Evidence:** passwords need 12 to 128 code points; logins are rate-limited and failed logins raise alerts (SR-01).
- **Status:** Accepted Risk. Revisit if the site gains accounts outside a circle of friends.

#### SR-61 A new OpenAI key needs a restart

- **Severity:** Info.
- **Location:** `server/receipt-ai.js:97-102` reads the key once in `createReceiptAi`.
- **Status:** Accepted Risk. Requirement 16.7 accepts a restart; the Security_Report rotation steps include it.

## OWASP Top 10 (2021)

| Category | Findings | Controls |
| --- | --- | --- |
| A01 Broken Access Control | SR-10, SR-25, SR-26, SR-29, SR-36, SR-45, SR-53, SR-59 | `requireUser`/`requireAdmin` (`server/accounts.js:544-546`), `tripAccess` and `ledgerAccess` (`:626-708`), Origin and `Sec-Fetch-Site` gate (`:1446-1447`) |
| A02 Cryptographic Failures | SR-21, SR-22, SR-36 | scrypt and SHA-256 token hashes; HSTS and TLS at nginx (`docs/deploy-nginx.md:374`) |
| A03 Injection | SR-09, SR-27, SR-40, SR-43, SR-49 | `?` placeholders; Escape_Function; CSP `script-src 'self'` |
| A04 Insecure Design | SR-02, SR-44, SR-48, SR-50, SR-60 | persistent AI quota; login, registration, and preview limits |
| A05 Security Misconfiguration | SR-04, SR-07, SR-08, SR-12, SR-14, SR-15, SR-30, SR-33, SR-34, SR-35, SR-42, SR-55, SR-58 | Startup_Validator, security headers, Static_Allowlist, DB path guard |
| A06 Vulnerable and Outdated Components | SR-16, SR-54 | [Dependency_Audit](#dependency_audit): zero advisories, Bun 1.3.14 is the latest 1.3 patch |
| A07 Identification and Authentication Failures | SR-05, SR-20, SR-21, SR-22, SR-23, SR-24, SR-41, SR-57 | dummy hash, session replacement, `SameSite=Strict` cookie |
| A08 Software and Data Integrity Failures | SR-28, SR-38 | `--frozen-lockfile` Docker install (`Dockerfile:5`); `cleanState` and `validateLedgerBody`; no `/api/` caching |
| A09 Security Logging and Monitoring Failures | SR-01, SR-11, SR-46, SR-47 | Security_Event_Store, Alert_Dispatcher, safe log lines, `audit` table |
| A10 Server-Side Request Forgery | SR-31 | the only outbound request goes to the fixed URL `https://api.openai.com/v1/chat/completions` with `redirect: 'error'` (`server/receipt-ai.js:115-116`); no request uses a user-supplied URL |

Secret handling Findings (SR-03, SR-17, SR-18, SR-19, SR-39, SR-61) sit across A02 and A05; SR-13, SR-32, SR-37, SR-51, SR-52, and SR-56 sit under A04 and A05 as listed in the topic sections below.

## Topic sections

### Invite token handling

Findings: SR-36, SR-46, SR-47, SR-48.

- **Signed-out Invite_Preview:** `GET /api/invites/{token}/preview` (`server/accounts.js:1085-1091`) checks the `invitePreview` limit before the lookup, reads no session, writes nothing, and returns exactly title, destination, start date, end date, and inviter display name.
- **Invite registration:** `POST /api/invites/{token}/register` (`:1130-1158`) spends the shared `register` bucket, validates input, checks the invite before hashing, and re-checks inside the transaction that creates the user, adds the member, and consumes the invite.
- **Single use:** `consumeInvite` matches only `used_at IS NULL` (`:466`), so a second use gets 404.
- **Invite_List:** selects no token hash, account ID, or username (`:468-475`); Members see only their own links.
- **Revoke by Invite_ID:** `POST /api/trips/{id}/invites/{inviteId}/revoke` (`:1094-1107`) allows the creator, the owner, or an Admin.
- Every unusable token gets the same 404 body (`:765`, `:772`).

### First-admin setup and the Create_Admin_CLI

Findings: SR-21, SR-45, SR-51.

- `POST /api/setup` exists only in Local_Mode (`server/accounts.js:1399`) and accepts only loopback callers (`:826`, `isLoopback` at `:284-289`) while no user exists (`:828`). `createFirstAdmin` checks and inserts in one `BEGIN IMMEDIATE` transaction (`:516-526`).
- In Published_Mode the first Admin comes from `bun run create-admin` (`scripts/create-admin.mjs`), which needs a terminal (`:115`), reads the password without echo, refuses a password argument and `CAMPING_ADMIN_PASSWORD`, and refuses `:memory:` (`:118`). Covered by `tests/create-admin.test.js`.
- The Docker local-only exception is SR-45.

### Deployment configuration and the Startup_Validator

Findings: SR-03, SR-12, SR-35, SR-58.

`parseDeploymentConfig` (`server/deploy-config.js:177-235`) and `parseAiCostConfig` (`server/ai-cost.js:72-86`) both throw `ConfigError`; `scripts/serve.mjs:11-12` prints `Configuration error: <message>` and exits 1 before listening. The DB path guard runs next (`scripts/serve.mjs:15-18`). Published_Mode requires an `https:` public origin, refuses open registration, `CAMPING_LOCAL_EXTRA_HOSTS`, and `CAMPING_DOCKER_LOCAL_ONLY`, and binds to loopback unless explicitly opted in. Startup log lines come only from configuration fields (`server/deploy-config.js:249`).

### Service worker cache

Findings: SR-38.

The generated `sw.js` (`scripts/build.mjs:26-33`) caches only the build's static files and optional assets. Its fetch handler returns early for non-GET requests, other origins, and every `/api/` path, so no account data is cached. Navigations fall back to the cached `index.html`, which holds no account data. Logout does not need to clear the cache for that reason. Published_Mode uses a separate cache name (`-p` suffix) and leaves `/demo` navigations to the network.

### Denial of service through request size and concurrency

Findings: SR-13, SR-32, SR-37, SR-44, SR-50.

| Limit | Value | Location |
| --- | --- | --- |
| Bun request body | 4,194,304 bytes | `scripts/serve.mjs:19` |
| nginx body | 4 MiB | `docs/deploy-nginx.md:395` |
| JSON body | 1,048,576 bytes, stops reading past the limit | `server/accounts.js:19`, `:602-621` |
| Receipt image | 3.5 MiB, read with a limit | `server/receipt-ai.js:8`, `server/accounts.js:1263-1270` |
| Receipt AI in flight | 1 per user, 2 overall | `server/accounts.js:1265` |
| Receipt AI quota | 10 per user per 15 min, 100 per UTC day, 1000 per UTC month (defaults) | `server/ai-cost.js:14-21` |
| Login password considered | first 1024 characters only, longer passwords fail without a long scrypt run | `server/accounts.js:888` |
| Sessions per user | 20 newest kept | `server/accounts.js:30`, `:558` |
| Audit, events, alerts | 5000, 5000, 1000 rows | `server/accounts.js:31`; `server/security-events.js:146` |
| Rate_Limiter map | 10,000 keys (see SR-44) | `server/accounts.js:248` |

Each login runs one scrypt (about 50 ms); the `loginClient` limit caps this at 30 per Client_Address per 15 minutes.

### Prompt injection through receipt images

Findings: SR-43.

Text printed on a receipt reaches the model as image content. The controls are: the system prompt tells the model that image text is data, never instructions, and that no tools exist (`server/receipt-ai.js:81`); the request offers no tools and asks for `json_object` output (`:118-129`); the reply must finish with `stop` and must not be a refusal (`:137`); `normalizeAiReceipt` (`:52-79`) keeps only known fields, caps text lengths, accepts only TWD, rejects unknown categories, clears amounts for uncertain and total rows, and never computes missing amounts; the browser shows the result as an editable draft that the user confirms, and renders every field through the Escape_Function. The worst outcome of an injected receipt is wrong draft rows in the user's own ledger, which the user sees before saving. The model never receives the OpenAI_Key, session data, or other users' data.

## CSRF_Decision

Decision (Requirement 10.9): defend Mutating_Requests with an exact `Origin` match against the Expected_Origin (`server/accounts.js:1446`), a `Sec-Fetch-Site: cross-site` refusal (`:1447`), JSON-only bodies on JSON_Routes (`requireJsonType`, `:62-65`), and `SameSite=Strict` Session_Cookies (`:529`), without a synchronizer token.

Reasoning:

1. The App_Shell and the API share one origin, so the browser always sends the site's own `Origin` on its `fetch` calls.
2. Every cookie-authenticated Mutating_Request carries a JSON body, or for receipt AI an `image/jpeg` or `image/png` body plus the custom headers `x-camping-user-id` and `x-receipt-consent`. A cross-site HTML form can send none of these content types.
3. A cross-site `fetch` with such a content type or custom header needs a CORS preflight. The App_Server answers every `OPTIONS` to `/api/` with 405 and sends no `Access-Control-*` header (SR-08, SR-30), so the browser never sends the real request.
4. `SameSite=Strict` keeps the cookie off cross-site requests in current browsers even if a check above failed.
5. The [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) lists verifying the origin with standard headers, Fetch Metadata, and SameSite cookies as defenses, and notes that APIs that accept only JSON and rely on CORS preflight are not exposed to simple form posts.

Revisit rule (Requirement 10.10): if any route starts accepting `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`, record here whether that route gets a synchronizer token and why. No route accepts these types today; `tests/security-csrf.test.js` "Property 15: the CSRF gate follows its decision table" fails if a JSON_Route starts accepting them.

## Admin trip access

Intended behavior, confirmed by the operator (Requirement 6.8, 6.9):

- An Admin has read and manage access to every live trip, whether or not the Admin is a Trip_Participant: `capabilities` treats `role === 'admin'` as manage (`server/accounts.js:624-627`), and `GET /api/trips` returns all live trips to an Admin (`:910`).
- Participant_Only_Routes (ledger read and write, receipt AI status and recognition) require a bound person in the trip, also for an Admin (`ledgerAccess`, `:703-708`). An Admin who is not a person in the trip gets the same 404 as for a missing trip, so ledger data and receipt AI use stay with the trip's people.

Covered by `tests/security-access.test.js` "an Admin outside the trip manages it but gets 404 on Participant_Only_Routes".

## Form and field table

Every form in the App_Shell, the route it sends to, and the server rule for each field (Requirement 8.7). "Req." means required. Lengths count Unicode code points unless noted. Every JSON route also requires `Content-Type: application/json`, a body of at most 1 MiB, and a JSON object (`server/accounts.js:602-621`).

| Form (file) | Route | Field | Type | Limit | Allowed values | Req. |
| --- | --- | --- | --- | --- | --- | --- |
| Sign in (`src/accounts-ui.js:321`) | `POST /api/login` | `username` | string | trimmed, lowercased, first 64 chars | any | yes |
| | | `password` | string | first 1024 chars considered | any | yes |
| First-admin setup (`src/accounts-ui.js:321`) | `POST /api/setup` | `username` | string | 3–32 | `^[a-z][a-z0-9-]{2,31}$`, not reserved (`api`, `admin`, `setup`, `login`, `register`, `logout`, `demo`, `assets`) | yes |
| | | `displayName` | string | 1–30 after NFKC and trim; no control characters | any | yes |
| | | `password` | string | 12–128 | any | yes |
| Open registration (`src/accounts-ui.js:321`) | `POST /api/register` | `username`, `displayName`, `password` | as setup | as setup | as setup | yes |
| Invite registration (`src/accounts-ui.js:548`) | `POST /api/invites/{token}/register` | `username`, `displayName`, `password` | as setup | as setup | as setup | yes |
| | | `name` | string | 1–30, unique in the trip | any | no (defaults to `displayName`) |
| | | `role` | string | 0–60 | any | no |
| Join trip (`src/accounts-ui.js:599`) | `POST /api/invites/{token}/join` | `name` | string | 1–30, unique in the trip | any | yes |
| | | `role` | string | 0–60 | any | no |
| New trip (`src/accounts-ui.js:395`) | `POST /api/trips` | `title` | string | 1–100 after trim | any | yes |
| | | `destination` | string | 0–100 | any | no |
| | | `startDate`, `endDate` | string | valid dates, end ≥ start, at most 31 days | `YYYY-MM-DD` | yes |
| | | `description`, `note` | string | 0–1000 | any | no |
| | | `coverKind` | string | — | `camp`, `mountain`, `lake`, `night`, `forest`, `beach`, `sunrise` | no |
| | | `status` | string | — | `planning`, `completed` | no |
| | | `expectedUserId` | string | equals the session user | — | yes |
| Trip import (`src/accounts-ui.js:514`) | `POST /api/trips` | file | JSON | ≤ 1 MiB in the browser | `legacyState` must pass `cleanState` and `isValidState` | yes |
| Trip settings (`src/app.js:293`) | `PATCH /api/trips/{id}` | as New trip, all optional | | | | `revision`, `expectedUserId` yes |
| Trip editor dialogs: activity, meal, shopping, gear, person, vehicle (`src/app.js:276-292`) | `PUT /api/trips/{id}` | `state` | object | `cleanState` keeps schema fields; `isValidState`: ≤ 100 people, ≤ 1000 items per list, each text field ≤ 5000 chars; trip text as New trip; names 1–30 and roles 0–60 for bound people | schema in `src/model.js:88-100` | yes |
| | | `revision`, `expectedUserId` | integer, string | current revision | — | yes |
| Checkboxes (`src/app.js`) | `POST /api/trips/{id}/check` | `kind` | string | — | `shopping`, `gear`, `depart` | yes |
| | | `checked` | boolean | — | — | yes |
| | | `id` | string | existing item | — | for shopping and gear |
| Invite link button (`src/app.js:523`) | `POST /api/trips/{id}/invites` | `expectedUserId` | string | session user; 20 active links per trip, 5 per Member | — | yes |
| Revoke link (`src/app.js`, Invitation_Dialog) | `POST /api/trips/{id}/invites/{inviteId}/revoke` | `expectedUserId` | string | session user | — | yes |
| Delete trip (`src/accounts-ui.js:436`) | `POST /api/trips/{id}/delete` or `/api/admin/trips/{id}/delete` | `confirmTitle` | string | equals the trip title | — | yes |
| | | `revision`, `expectedUserId` | integer, string | current | — | yes |
| Expense and settlement editors (`src/expenses-ui.js:644`, `:658`) | `PUT /api/trips/{id}/ledger` | ledger body | object | `validateLedgerBody`: unknown keys rejected; ≤ 1000 rows, title ≤ 100, note ≤ 500, amounts ≤ 100,000,000 cents, ≤ 100 participants, category from `src/expense-categories.js` | `server/ledger.js:10`, `:174` | yes |
| Receipt photo (`src/expenses-ui.js:670`) | `POST /api/trips/{id}/receipt-ai` | body | JPEG or PNG bytes | ≤ 3.5 MiB, ≤ 8000 px per side, ≤ 20,000,000 px, complete file | headers `x-camping-user-id` (session user) and `x-receipt-consent: openai-v1` | yes |
| Admin user edit (`src/accounts-ui.js:740`) | `PATCH /api/admin/users/{id}` | `displayName` | string | as setup | — | no |
| | | `role` | string | — | `admin`, `member`; not self-demotion; at least one Admin kept | no |
| Admin user delete (`src/accounts-ui.js:760`) | `POST /api/admin/users/{id}/delete` | `confirmUsername` | string | equals the target username; not self | — | yes |
| Site settings (`src/accounts-ui.js:652`) | `PATCH /api/admin/settings` | `receiptAiPolicy` | string | — | `all`, `admins`, `off` | yes |
| Alert acknowledge button (`src/accounts-ui.js:696-700`) | `POST /api/admin/security/alerts/{id}/acknowledge` | body | `{}` | — | — | yes |
| Logout button | `POST /api/logout` | no body | — | — | — | — |
| Local planner import (`src/app.js:314`, `:406`) | none (browser only) | file | JSON | ≤ 1 MiB | must pass `isValidState` | yes |

## HTML_Sink inventory

Search: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` over `src/*.js` (Requirement 9.9). 45 lines match: 29 in `src/accounts-ui.js`, 11 in `src/app.js`, 5 in `src/expenses-ui.js`. No `outerHTML`, `insertAdjacentHTML`, or `document.write` exists. Labels: **escaped** (passed through `e()`/`escape`), **constant** (string literal in `src/`), **markup** (trusted App_Shell markup built by a named helper from constants and escaped values), **format** (server value with a fixed format that is not User_Content). Zero values are unescaped User_Content.

| File:line | Sink target | Interpolated values |
| --- | --- | --- |
| `src/accounts-ui.js:135` | `#app` | constant `''` |
| `src/accounts-ui.js:184` | `#app` (message page) | `illustration()` markup; `title`, `body` escaped; `actions` constant markup from callers |
| `src/accounts-ui.js:197` | theme button | `icon()` markup |
| `src/accounts-ui.js:211` | dialog | `title` escaped; `icon()` markup; `body` markup built by callers with `e()` |
| `src/accounts-ui.js:225` | dialog | constant `''` |
| `src/accounts-ui.js:318` | `#app` (registration closed) | `art`, `copy.eyebrow` constant; `copy.title` escaped; `nextQuery` escaped |
| `src/accounts-ui.js:321` | `#app` (login, register, setup) | `copy.*` escaped or constant; `nextNote`, `accountFields`, `formError()`, `links` markup |
| `src/accounts-ui.js:481` | `#trip-list` | `listHtml()` markup (`tripCard` escapes trip fields) |
| `src/accounts-ui.js:495` | `#app` (home) | `user.displayName` escaped; `icon()` markup |
| `src/accounts-ui.js:538` | `#app` (invite loading) | `illustration()` markup, constants |
| `src/accounts-ui.js:543` | invite content | `invalidInvite()` markup |
| `src/accounts-ui.js:544` | invite content | constant |
| `src/accounts-ui.js:545` | invite content | `errorBlock()` markup (escapes the message); `loginLink` markup |
| `src/accounts-ui.js:548` | invite content (signed out) | `inviteSummary(info)` markup (escapes title, destination, dates); `info.inviterName` escaped; `newAccountFields`, `field` markup |
| `src/accounts-ui.js:573` | invite content | `invalidInvite()` markup |
| `src/accounts-ui.js:584` | `#app` (invite loading) | `illustration()` markup, constants |
| `src/accounts-ui.js:591` | invite content | constant headings; `errorBlock()` markup; `homePath(user)` escaped |
| `src/accounts-ui.js:596` | invite content | `summary` markup; `homePath(user)` escaped |
| `src/accounts-ui.js:599` | invite content (signed in) | `user.displayName`, `user.username` escaped; `field()` markup with escaped values |
| `src/accounts-ui.js:625` | `#app` (admin) | constants |
| `src/accounts-ui.js:695` | `#admin-security` | `securityHtml()` markup: alert and event fields escaped, counts through `count()` |
| `src/accounts-ui.js:713` | `#admin-settings` | `settingsHtml()` markup |
| `src/accounts-ui.js:715` | `#admin-ai-usage` | `usageHtml()` markup: model fields escaped, numbers through `count()` |
| `src/accounts-ui.js:718` | `#admin-stats` | label constant; `n` escaped |
| `src/accounts-ui.js:719` | `#admin-users` | `userRow` markup; `errorBlock()` markup; constants |
| `src/accounts-ui.js:720` | `#admin-trips` | `tripCard` markup; constants |
| `src/accounts-ui.js:721` | `#admin-audit` | `auditRow` markup; constants |
| `src/accounts-ui.js:799` | `#app` | constant |
| `src/accounts-ui.js:808` | `#app` | constant |
| `src/app.js:81` | `#app` (planner) | `header()`, `invite()`, `home()`, `privacy()`, `departure()`, `trip()`, `footer()` markup; constants |
| `src/app.js:221` | dialog | `title` constant (every `formDialog` and `showDialog` caller passes a literal, `src/app.js:276-293`, `:305-322`, `:523`); `content` markup |
| `src/app.js:237` | recipe preview | `recipe.title`, `recipe.ingredients` escaped |
| `src/app.js:246` | `#ingredient-preview` | `ingredientPreview()` markup (escapes each ingredient) |
| `src/app.js:252` | `#ingredient-preview` | `ingredientPreview()` markup |
| `src/app.js:449` | `#ingredient-preview` | `ingredientPreview()` markup |
| `src/app.js:451` | `#ingredient-preview` | `ingredientPreview()` markup |
| `src/app.js:481` | sync status | constants chosen by booleans |
| `src/app.js:485` | identity note | `icon()` markup; `account.user.displayName` escaped; constants |
| `src/app.js:492` | `main` | constants; `accountTripPath()` format (see SR-59) |
| `src/app.js:493` | save warning | `accountError` escaped; `button()` markup |
| `src/expenses-ui.js:727` | ledger summary | `summaryHtml()` markup |
| `src/expenses-ui.js:729` | discrepancy box | `discrepancyHtml()` markup |
| `src/expenses-ui.js:731` | blockers box | `blockersHtml()` markup |
| `src/expenses-ui.js:783` | expenses view | `view()` markup (rows, titles, notes, AI suggestions escaped) |
| `src/expenses-ui.js:990` | expenses view | constant `''` |

The helpers labeled markup are covered end to end by `tests/security-xss.e2e.js`, which stores every XSS_Payload_Set string in User_Content and checks the home page, trip page tabs, both invite pages, the Invitation_Dialog, the expenses view, and the Admin_Page for dialogs, page errors, CSP violations, a `window` sentinel, and unexpected elements.

## Environment variable table

Every environment variable read in `server/`, `scripts/`, `src/`, `Dockerfile`, and `docker-compose.yml` (Requirement 14.1, 14.2). `src/` reads none: the only `CAMPING_` text there is a help string at `src/accounts-ui.js:641`. No variable reaches the Build_Output (`scripts/build.mjs` passes no `define` to `Bun.build`; `tests/security-files.test.js` checks the build for canaries).

| Name | Read at (file:line) | Default | Secret | Reach |
| --- | --- | --- | --- | --- |
| `CAMPING_PUBLISHED` | `server/deploy-config.js:15`, `:178` | `0` | no | server only |
| `CAMPING_PUBLIC_ORIGIN` | `server/deploy-config.js:16`, `:147`; `scripts/create-admin.mjs:82` | none (required when published) | no | server only |
| `CAMPING_TRUSTED_PROXIES` | `server/deploy-config.js:17`, `:196` | empty; `127.0.0.1,::1` when published | no | server only |
| `CAMPING_LOCAL_EXTRA_HOSTS` | `server/deploy-config.js:18`, `:205` | empty | no | server only |
| `CAMPING_ALLOW_NON_LOOPBACK_BIND` | `server/deploy-config.js:19`, `:179` | `0` | no | server only |
| `CAMPING_REGISTRATION` | `server/deploy-config.js:20`, `:215` | `open` (Local_Mode), `closed` (published) | no | server only |
| `CAMPING_RECEIPT_AI_POLICY` | `server/deploy-config.js:21`, `:220` | none (policy `all`) | no | server only |
| `CAMPING_DOCKER_LOCAL_ONLY` | `server/deploy-config.js:22`, `:180`; set at `Dockerfile:14` | unset; `1` in the image | no | server only |
| `HOST` | `server/deploy-config.js:24`, `:188`; set at `Dockerfile:13` | `127.0.0.1`; `0.0.0.0` in the image | no | server only |
| `PORT` | `server/deploy-config.js:25`, `:164`; `scripts/create-admin.mjs:84`; set at `Dockerfile:12` and `scripts/check-accounts.mjs:10` | `5173`; `5174` in the image | no | server only |
| `CAMPING_DB` | `server/deploy-config.js:240` (used by `scripts/serve.mjs:13` and `scripts/create-admin.mjs:117`); set at `Dockerfile:15` and `scripts/check-accounts.mjs:10` | `data/accounts.sqlite`; `/app/data/accounts.sqlite` in the image | no | server only |
| `CAMPING_DIST` | `scripts/serve.mjs:14`; `scripts/build.mjs:5` | `dist` | no | build and server; names the output directory, not inlined |
| `CAMPING_OPENAI_API_KEY` | `server/receipt-ai.js:98` | none | **yes** | server only |
| `CAMPING_OPENAI_API_KEY_FILE` | `server/receipt-ai.js:97`; set at `Dockerfile:16` | `.secrets/openai_api_key`; `/run/secrets/openai_api_key` in the image | **yes** (path to a key file, Req 14.2; see SR-58) | server only |
| `CAMPING_OPENAI_MODEL_ID` | `server/ai-cost.js:6`, `:51-53`; fallback `server/receipt-ai.js:94` | `gpt-6-luna` | no | server only |
| `CAMPING_OPENAI_IMAGE_DETAIL` | `server/ai-cost.js:7`, `:62-63` | `high` | no | server only |
| `CAMPING_OPENAI_MAX_COMPLETION_TOKENS` | `server/ai-cost.js:8`, `:38-40`, `:75` | `6000` | no | server only |
| `CAMPING_RECEIPT_AI_USER_LIMIT` | `server/ai-cost.js:9`, `:76` | `10` | no | server only |
| `CAMPING_RECEIPT_AI_DAILY_LIMIT` | `server/ai-cost.js:10`, `:77` | `100` | no | server only |
| `CAMPING_RECEIPT_AI_MONTHLY_LIMIT` | `server/ai-cost.js:11`, `:81` | `1000` | no | server only |
| `CAMPING_BUN` | `scripts/check-accounts.mjs:8` | none (required) | no | e2e runner only |
| `CHROME_PATH` | `scripts/check-accounts.mjs:14`, `:23` | `C:/Program Files/Google/Chrome/Application/chrome.exe` | no | e2e runner only |
| `CAMPING_BIND_ADDRESS` | `docker-compose.yml:5` | `0.0.0.0` | no | Docker host only |
| `CAMPING_HOST_PORT` | `docker-compose.yml:5` | `5182` | no | Docker host only |
| `CAMPING_DATA_VOLUME` | `docker-compose.yml:14` | `little-moments-initial-setup-data` | no | Docker host only |

`CAMPING_ADMIN_PASSWORD` is not read anywhere; `tests/create-admin.test.js` "CAMPING_ADMIN_PASSWORD in the environment is ignored" checks that.

## Password hash inspection

Requirement 2.8. An Accounts_DB exists in the workspace at `data/accounts.sqlite` (with `-wal` and `-shm` files); `CAMPING_DB` was unset. On 2026-11-08T18:18:21Z a temporary Bun script, deleted afterwards, did the following:

1. computed the SHA-256 of `data/accounts.sqlite`, `data/accounts.sqlite-wal`, and `data/accounts.sqlite-shm`;
2. opened the database with `new Database(path, { readonly: true })`, ran `SELECT password_hash FROM users`, and closed it;
3. classified each value without printing it: scrypt format of Requirement 2.1 (six `$` fields starting with `scrypt`, N a power of 2, r = 8, p = 1, 16-byte base64 salt, 64-byte base64 hash), scrypt with N below 16384, or not in the format;
4. computed the three checksums again.

| Result | Count |
| --- | --- |
| `users` rows | 1 |
| values in the Requirement 2.1 format with N ≥ 16384 | 1 |
| values not in the format | 0 |
| scrypt values with N < 16384 | 0 |

| File | SHA-256 before | SHA-256 after |
| --- | --- | --- |
| `data/accounts.sqlite` | `8ce14d4b7ef48d31dc55dfcda23d568537dea6f2cd83e4e147c5ec24da076f51` | `8ce14d4b7ef48d31dc55dfcda23d568537dea6f2cd83e4e147c5ec24da076f51` |
| `data/accounts.sqlite-wal` | `119f142fbf777e90e947aa035785d63c8af0d4dc5f13064d33050aa2ccb081f6` | `119f142fbf777e90e947aa035785d63c8af0d4dc5f13064d33050aa2ccb081f6` |
| `data/accounts.sqlite-shm` | `8f9e7ab2e163e920c1515b20b582ac57842202f87826de3b839d8083ea254fd4` | `8f9e7ab2e163e920c1515b20b582ac57842202f87826de3b839d8083ea254fd4` |

All three checksums are unchanged. No hash, salt, or username was printed or recorded.

## Checked with no Finding

- **README receipt photo limits.** `README.md:97` says JPEG, PNG, and WebP photos up to 10 MB or 20 megapixels are accepted and that the prepared image is resized for the request. That describes the browser side correctly: `src/expenses-ui.js:6-8` and `src/receipt-image.js:48-49` accept those types and sizes, and `prepareAiImage` (`src/receipt-ai-client.js:89-125`) re-encodes to a JPEG of at most 3.5 MiB and 8000 px per side before upload. The server limits (SR-32) apply to the re-encoded image. `README.md` was not changed.
- **Host header and DNS rebinding.** Local_Mode accepts only loopback names, IP literals, and `CAMPING_LOCAL_EXTRA_HOSTS`; Published_Mode accepts only the public hostname and direct-local loopback (`server/deploy-config.js:96-100`). A rebinding attack uses a hostname that is not on these lists and gets 403 (`tests/deploy-config.test.js` Property 4).
- **Open redirect.** The only redirect target from user input is the `next` parameter, limited by `safeNext` (SR-10).
- **Clickjacking.** `frame-ancestors 'none'` and `X-Frame-Options: DENY` (SR-04).
- **Session fixation.** Every successful sign-in path issues a new token and deletes the incoming one (SR-22).

## Dependency_Audit

Run on 2026-11-09 02:06 local time (2026-11-08T18:06:56Z) on Windows with Bun 1.4.4 (`bun --version`), in the workspace root. Requirements 21 and 22.

### Vulnerability check (Requirement 21.1 to 21.3, 21.11)

| Item | Value |
| --- | --- |
| Command | `bun audit` |
| Tool version | `bun audit v1.4.4 (38afee6c8)` |
| Advisory database | npm registry advisory endpoint (`registry.npmjs.org`, backed by the GitHub Advisory Database). No `bunfig.toml` or `.npmrc` exists, so no scoped registry was used and no package was skipped. Source: [bun audit docs](https://bun.com/docs/pm/cli/audit). |
| Date and time | 2026-11-08T18:06:56Z |
| Packages checked | 6 (every entry in `bun.lock`, direct and transitive) |
| Result | `No vulnerabilities found (checked 6 packages)`, exit code 0 |
| Advisories | none |
| Status | Complete, passed |

Packages in `bun.lock`:

| Package | Version | Direct or transitive | Required by |
| --- | --- | --- | --- |
| `@playwright/test` | 1.56.1 | direct (devDependencies) | `package.json` |
| `fast-check` | 4.10.2 | direct (devDependencies) | `package.json` |
| `playwright` | 1.56.1 | transitive | `@playwright/test` |
| `playwright-core` | 1.56.1 | transitive | `playwright` |
| `fsevents` | 2.3.2 | transitive, optional, macOS only | `playwright` |
| `pure-rand` | 8.4.2 | transitive | `fast-check` |

No advisory has a fixed version, so no package was updated (21.4), no Build_Script pin needed a change (21.5; `scripts/build.mjs` pins no package after task 2.2 removed the OCR copy list), and no advisory needs an upgrade, replace, remove, or accept decision (21.6). The rerun of 21.11 is the same audit: zero advisories remain.

### Package classification (Requirement 22.1 to 22.3)

`package.json` has no `dependencies` section. `src/`, `server/`, and `scripts/build.mjs` import no third-party package: a search for bare-specifier imports in those paths finds only `node:` and `bun:` built-ins.

| Package | Section | Class | Evidence |
| --- | --- | --- | --- |
| `@playwright/test` | devDependencies | tests only | `playwright.config.js:1`, `tests/expense-fixture.js:1`, `tests/local-planner-fixture.js:1`, `tests/security-xss.e2e.js:21`, and the other `tests/*.e2e.js` files; `scripts/check-accounts.mjs:5` imports its dependency `playwright` to drive the e2e run |
| `fast-check` | devDependencies | tests only | imported by 16 `tests/*.test.js` files, for example `tests/ai-cost.test.js:2`, `tests/security-auth.test.js:5`, `tests/publish.test.js:4` |

No package is unused, so nothing was removed (22.2). No package sits in `dependencies`, so nothing was moved (22.3). The Docker build stage runs `bun install --frozen-lockfile --production`, which installs neither package into the image.

Observation for task 13.2 (Info): `scripts/check-accounts.mjs:5` imports `playwright`, which is not declared in `package.json` and resolves only because `@playwright/test` depends on it at the same version. This is a test-tool hygiene note with no security impact.

### Browser OCR path (Requirement 22.4)

Answer: **no**. The App_Shell does not reach the browser OCR path from `src/entry.js` through static or dynamic imports, because every part of the path is gone after tasks 2.1 to 2.5 and 4.1:

| Part | Evidence |
| --- | --- |
| `recognizeReceipt` in `src/receipt-ocr.js` | `src/receipt-ocr.js` does not exist. The image helpers now live in `src/receipt-image.js`, imported by `src/receipt-ai-client.js:1` and `server/receipt-ai.js:4`. |
| `tesseract.js`, `tesseract.js-core`, `@tesseract.js-data/chi_tra`, `@tesseract.js-data/eng` | No entry in `package.json` or `bun.lock`; `node_modules/tesseract.js` does not exist. A search for `tesseract` in `src/`, `server/`, `scripts/`, `package.json`, `bun.lock`, `README.md`, and `Dockerfile` returns zero matches. |
| OCR copy step and `assets/ocr/` in `sw.js` | `scripts/build.mjs` has no OCR copy list; `dist/assets/ocr` does not exist after `bun run build`. `scripts/build.mjs:26` still writes `const PUBLISHED=false;` as the first line of `sw.js`. Covered by `tests/security-files.test.js` (fresh build check) and `tests/ocr-assets.e2e.js`. |
| `'wasm-unsafe-eval'` in the CSP | `server/http.js:5` sets `script-src 'self'` with no `'wasm-unsafe-eval'`. Covered by `tests/security-headers.test.js` and `tests/ocr-assets.e2e.js`. |

The stale directory `.tmp-e2e-dist/assets/ocr/` is left over from an e2e run before this spec. It is not the Build_Output and is not served by default; it is noted here so task 13.2 can record it (Info).

### Bun base image (Requirement 21.7, 21.8)

| Item | Value |
| --- | --- |
| `Dockerfile` `FROM` lines | line 1 `oven/bun:1.3.14-alpine AS build`, line 9 `oven/bun:1.3.14-alpine AS runtime` |
| Current version | 1.3.14 |
| Latest patch of 1.3 | 1.3.14 (`1.3.14-alpine` pushed 2026-05-13; no `1.3.15` or later tag exists) |
| Source | Docker Hub tag list for `oven/bun` (`https://hub.docker.com/v2/repositories/oven/bun/tags?name=1.3.`) and [Bun v1.3.14 release](https://github.com/oven-sh/bun/discussions/30607) |
| Date checked | 2026-11-09 |
| Action | None. Both lines already use the latest 1.3 patch. |

Bun 1.4.x exists (the workspace runs 1.4.4), but moving the image to 1.4 is a minor-version change outside Requirement 21.8 and was not made.

### Test runs (Requirement 21.9, 21.10, 22.7, 22.8)

No package or base image changed in this task, so nothing needed a revert. The runs below also serve as the task 12 checkpoint. All runs on 2026-11-09, Bun 1.4.4, Chrome at the default path.

| Suite | Command | Passed | Failed | Skipped | Exit code |
| --- | --- | --- | --- | --- | --- |
| Build | `Remove-Item Env:CAMPING_DIST -ErrorAction SilentlyContinue; bun run build` | — | — | — | 0 |
| Unit_Suite | `bun test tests` (CAMPING_DIST unset), 42 files, 108 s | 930 | 0 | 0 | 0 |
| E2E_Suite, PBN file set | `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs tests/accounts.e2e.js tests/invite-registration.e2e.js tests/invite-links.e2e.js tests/trip-deletion.e2e.js tests/vehicle-departures.e2e.js tests/brand.e2e.js tests/ocr-assets.e2e.js tests/receipt-ocr.e2e.js`, 5.3 min | 28 | 8 | 0 | 1 |
| E2E_Suite, security files | `node scripts/check-accounts.mjs tests/security-pages.e2e.js tests/security-xss.e2e.js`, 12.7 s | 8 | 0 | 0 | 0 |

The eight PBN-set failures are exactly the eight baseline failures in `docs/security-report.md`: `tests/brand.e2e.js:40`, `:55`, `:80`, `:93`; `tests/receipt-ocr.e2e.js:43`; `tests/trip-deletion.e2e.js:83`, `:140`; `tests/vehicle-departures.e2e.js:245`. No new failure appeared. `tests/ocr-assets.e2e.js`, rewritten in task 2.4, passes.
