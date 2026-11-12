# Requirements Document

## Introduction

This feature is a security pass over the account version of the app (日子拾光 / Little Moments). The app is a Bun server (`scripts/serve.mjs`, `server/http.js`, `server/accounts.js`, `server/ledger.js`, `server/receipt-ai.js`) with a SQLite accounts database (`bun:sqlite`, default `data/accounts.sqlite`), a browser bundle built by `scripts/build.mjs` into `dist/`, receipt recognition through the OpenAI Chat Completions API, and a Docker image. The operator plans to publish the site at `https://www.our-littlemoments.com` behind nginx, as described in the `publish-behind-nginx` spec.

The pass covers the operator's 25-item list: authentication, password storage, cookies, rate limits, admin access, data isolation, SQL, server validation, XSS, CSRF, security headers, CORS, API keys, environment variables, secret scanning, key rotation, uploads, OpenAI cost, debug output, file exposure, dependencies, failed-login alerts, a full review, tests, and a final report.

A code inspection before writing these requirements found that many controls already exist. These requirements therefore ask for two things per item: verify the existing control with automated tests, and close the gaps that the inspection found.

The `publish-behind-nginx` spec is now implemented and its Unit_Suite passes. The lists below were re-inspected against the code after that work (`server/http.js`, `server/accounts.js`, `server/deploy-config.js`, `server/settings.js`, `server/receipt-ai.js`, `scripts/serve.mjs`, `scripts/build.mjs`, `src/accounts-ui.js`, `src/app.js`). Criteria that the shipped code already satisfies are marked "Already in place" with the `publish-behind-nginx` (PBN) requirement and the test that covers them. The design and tasks of this spec do not reimplement them; the Security_Review records them as Already Mitigated with that evidence.

Controls already present:

- Passwords use scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte random salt) with a constant-time compare. Login against an unknown or deleted user verifies against a dummy hash. The same validators and hashing serve `POST /api/setup`, `POST /api/register`, `POST /api/invites/{token}/register`, and the Create_Admin_CLI.
- Session tokens are 32 random bytes. The database stores only their SHA-256 hash. The `ggc_session` cookie has `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Max-Age=604800`. The `Secure` attribute is set exactly when the request is a Proxied_Request in Published_Mode or the request URL is `https:` (PBN 5.1, 5.3). Login, registration, setup, and invite registration replace the incoming session; logout deletes it and sends a cleared cookie with the same attributes.
- Every request passes the Host allowlist before any other handling (PBN 3). Client_Address comes from the right-most untrusted `X-Forwarded-For` entry only for requests from Trusted_Proxies (PBN 6).
- `loginUser` (5 per 15 minutes per username), `loginClient` (30 per 15 minutes per Client_Address), `register` (20 per hour per Client_Address, shared by open and invite registration), and `invitePreview` (60 per 15 minutes per Client_Address) rate limits exist (PBN 7, 14.9, 15.4). A `POST /api/register` under the closed Registration_Policy returns 403 before the limiter and is not counted (PBN 10.2).
- Every non-GET `/api/` request must carry an `Origin` header equal to the Expected_Origin: the Public_Origin for a Proxied_Request in Published_Mode, otherwise the request URL origin (PBN 4). JSON routes require `Content-Type: application/json` and a body of at most 1 MiB.
- `POST /api/setup` and `/setup` do not exist in Published_Mode; the first Admin comes from the Create_Admin_CLI (PBN 8). `/demo/` returns 404 in Published_Mode (PBN 9). Open registration is locked in Published_Mode, and `CAMPING_REGISTRATION=open` with Published_Mode stops startup (PBN 2.12, 10). Note: jenkins-cicd-deploy Requirement 26 extends the Registration_Policy (admin toggle in `/admin`, deployment default `closed`).
- The Startup_Validator (`parseDeploymentConfig` in `server/deploy-config.js`) throws a `ConfigError` naming the setting, and `scripts/serve.mjs` prints `Configuration error: <message>` and exits 1 before listening (PBN 2).
- Admin routes read the requesting user's `role` and `deleted_at` from the Accounts_DB on every request through the session lookup, so a demotion or deletion takes effect on the next request.
- Signed-out visitors of `/invite/{token}` see only the Invite_Preview (trip title, destination, start date, end date, inviter display name) from the rate-limited `GET /api/invites/{token}/preview`, followed by the invite registration form (PBN 14.1, 15). Every unusable token returns the same 404. Invitation links are single-use and listed and revoked by Invite_ID (PBN 17–19).
- The Receipt_AI_Policy (`all`, `admins`, `off`) is stored in the Settings_Store, changed through `PATCH /api/admin/settings`, and applied through `receiptAiDecision` in `server/settings.js` and the `authorize()` closure in `recognizeReceiptAi` before and after the upload (PBN 11).
- All SQL statements use `db.query` with `?` placeholders, including the invite, settings, and migration queries.
- `server/http.js` serves only allowlisted static paths and sets a Content-Security-Policy and other security headers on every response, including the Published_Mode shell (with the injected `<meta name="camping-deployment" content="published">`) and the rewritten `sw.js`.
- The OpenAI key is read on the server from `CAMPING_OPENAI_API_KEY` or the file named by `CAMPING_OPENAI_API_KEY_FILE` (default `.secrets/openai_api_key`), sent only to `https://api.openai.com` with redirects refused. The browser sends receipts only to the App_Server.
- Receipt AI accepts only JPEG or PNG up to 3.5 MiB, 8000 px per side, and 20,000,000 px. Limits are 10 requests per user per 15 minutes, 100 per rolling 24 hours globally, 1 concurrent request per user, and 2 concurrent requests globally.
- The Example_Nginx_Config in `docs/deploy-nginx.md` sends HSTS `max-age=15552000`, sets `client_max_body_size 4m`, proxies every request to the App_Server, and contains no `Access-Control-*` header and no `OPTIONS` handling (PBN 5.4, 12).

Gaps found:

- Failed logins are not recorded anywhere, and no alert exists. Only successful logins are audited.
- Receipt AI rate limits live in memory and reset on every restart, and the daily limit is a rolling 24 hours. Token usage is not recorded. The model, `max_completion_tokens: 6000`, and `detail: 'high'` are fixed in `server/receipt-ai.js`, and an invalid `CAMPING_OPENAI_MODEL_ID` silently disables receipt AI instead of stopping startup.
- The CSP has `frame-ancestors 'self'`, keeps `'wasm-unsafe-eval'`, and lacks `object-src 'none'`. `X-Frame-Options` is `SAMEORIGIN`. `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are missing.
- 429 responses carry no `Retry-After` header.
- No `Sec-Fetch-Site` check exists. JSON handlers check the session before the content type, so a wrong content type without a session gets 401 instead of 415.
- `OPTIONS` to an `/api/` path that is not in the Route_Table returns 404 instead of 405.
- The Escape_Function `escape` in `src/model.js` does not escape the backtick.
- `safeNext` in `src/accounts-ui.js` accepts only `/invite/{token}` paths, and the home, trip, and admin pages redirect signed-out visitors to `/login` without a `next` value.
- Uncaught errors inside `accounts.handle` return the generic 500 without a log line.
- The Accounts_DB path check rejects `dist` and `public` path segments but does not resolve symlinks or compare with the configured Build_Output (`CAMPING_DIST`).
- The local-handbook import in `src/app.js` accepts files up to 2,000,000 bytes.
- `.dockerignore` does not exclude `.kiro`. The Example_Nginx_Config has no rule that returns 404 for dot-prefixed path segments.
- The workspace root is not a git repository, so git history cannot be scanned from this workspace.
- `tesseract.js` and the two `@tesseract.js-data` packages are runtime dependencies. `scripts/build.mjs` copies OCR files into `assets/ocr/`, and the Static_Allowlist serves them. No UI code imports `recognizeReceipt` from `src/receipt-ocr.js`, and the README states that the app has no local-OCR fallback. `server/receipt-ai.js` and `src/receipt-ai-client.js` import the image helpers `sniffImageType`, `readImageSize`, `validateReceiptBytes`, and `MAX_RECEIPT_PIXELS` from that file. `scripts/check-accounts.mjs` still sets the obsolete `CAMPING_BEDROCK_*` variables. The operator has confirmed removal of the browser OCR path (Requirement 22.5).
- No security review document or security report exists.

Scope: code, configuration, tests, and documentation in this repository. Revoking keys at OpenAI, rewriting the history of a remote repository, setting OpenAI billing limits, and changing the operator's server or nginx are operator actions. The Security_Report documents these actions, and the agent does not perform them. Sending Security_Alerts to LINE or any other external channel (email, webhook, chat) is out of scope. The operator plans a LINE webhook alert as a separate future feature, which will attach to the Alert_Dispatcher defined in Requirement 23.

Prerequisite: this spec builds on the implemented `publish-behind-nginx` spec and must not contradict its behavior. The re-inspection described above is done; the section "Alignment with publish-behind-nginx" at the end lists every change made to this document because of it.

## Glossary

- **App_Server**: The Bun process started by `scripts/serve.mjs`, consisting of the HTTP handler in `server/http.js`, the account service in `server/accounts.js`, the ledger logic in `server/ledger.js`, and the receipt AI client in `server/receipt-ai.js`.
- **agent**: The coding agent that implements this spec in the repository. The agent changes files and runs local commands, and does not act on external accounts or servers.
- **App_Shell**: The browser code built from `src/entry.js`, including `src/accounts-ui.js`, `src/app.js`, `src/expenses-ui.js`, and `src/receipt-ai-client.js`.
- **Build_Script**: `scripts/build.mjs`, which writes the browser bundle, assets, and `sw.js` into the Build_Output.
- **Build_Output**: The directory written by the Build_Script, `dist/` by default.
- **Accounts_DB**: The SQLite database opened by the App_Server at `CAMPING_DB`, default `data/accounts.sqlite`.
- **Session**: A row in the `sessions` table of the Accounts_DB that links the SHA-256 hash of a session token to a user and an expiry time.
- **Session_Cookie**: The `ggc_session` cookie that carries a session token.
- **Valid_Session**: A Session whose expiry time is in the future and whose user is not deleted.
- **Public_API**: The `/api/` routes that work without a Valid_Session: `GET /api/session`, `POST /api/login`, `POST /api/register`, `POST /api/logout`, `POST /api/setup` (Local_Mode only; absent from the Route_Table in Published_Mode), `GET /api/invites/{token}/preview` (rate-limited by `invitePreview`), and `POST /api/invites/{token}/register` (rate-limited by `register`).
- **Protected_API**: Every `/api/` route that is not in the Public_API, including `GET /api/invites/{token}`, `POST /api/invites/{token}/join`, `GET` and `POST /api/trips/{id}/invites`, and `POST /api/trips/{id}/invites/{inviteId}/revoke`. The Admin_API is a subset of the Protected_API.
- **Admin_API**: Every route under `/api/admin/`, including `GET` and `PATCH /api/admin/settings` (the Receipt_AI_Policy route defined by the `publish-behind-nginx` spec) and the security event and receipt AI usage routes added by this spec.
- **Route_Table**: The `table` array in `server/accounts.js` that maps API paths and methods to handlers. Its content depends on Published_Mode, because `/api/setup` is present only in Local_Mode.
- **Private_Page**: An App_Shell page that shows account data: `/{username}/home`, `/{username}/trips/{id}`, `/{username}/trips/{id}/go`, `/invite/{token}`, and `/admin`. The invite page has the Invite_Page_Carve_Out.
- **Invite_Preview**, **Valid_Invite**, **Invite_ID**, **Invite_List**, **Inviter**, **Create_Admin_CLI**, **Startup_Validator**, **Registration_Policy**, **Direct_Local_Request**: As defined in the `publish-behind-nginx` spec.
- **Invite_Page_Carve_Out**: The rule that a visitor without a Valid_Session who opens `/invite/{token}` for a Valid_Invite may see the Invite_Preview fields and the invite registration form, and no other account data, instead of being sent to `/login`.
- **ConfigError**: The error class exported by `server/deploy-config.js`, carrying the name of the invalid setting. `scripts/serve.mjs` prints `Configuration error: <message>` for it and exits with code 1 before listening.
- **Receipt_AI_Decision**: The result of `receiptAiDecision` in `server/settings.js` (`allow`, `no-edit`, `admins-only`, `off`, `unconfigured`), evaluated by `getReceiptAi` and by the `authorize()` closure of `recognizeReceiptAi`.
- **JSON_Route**: A Route_Table entry whose handler reads a JSON request body: every Mutating_Request route except `POST /api/logout` and `POST /api/trips/{id}/receipt-ai`.
- **Admin**: A user whose `role` column in the Accounts_DB is `admin` and whose `deleted_at` column is null.
- **Member**: A user whose `role` column is `member`.
- **Trip_Participant**: For a given trip, the trip owner or a user with a row in `trip_members` for that trip.
- **Trip_Scoped_Route**: A Protected_API route whose path contains a trip ID: trip read, update, patch, check, ledger read and write, receipt AI status and recognition, invite creation, Invite_List read, invite revoke by Invite_ID, and trip deletion.
- **Participant_Only_Route**: A Trip_Scoped_Route that requires the caller to be bound to a person in the trip, including for an Admin: ledger read and write, and receipt AI status and recognition.
- **Mutating_Request**: An `/api/` request whose method is not GET or HEAD. (A HEAD request to an API route receives 405 before any other check.)
- **Expected_Origin**: The origin a Mutating_Request must carry, as defined by the `publish-behind-nginx` spec: the Public_Origin for a proxied request in Published_Mode, otherwise the request URL origin.
- **Published_Mode**, **Public_Origin**, **Trusted_Proxies**, **Client_Address**, **Proxied_Request**, **Receipt_AI_Policy**, **Settings_Store**, **Example_Nginx_Config**, **Deployment_Guide**: As defined in the `publish-behind-nginx` spec.
- **Production_Deployment**: The App_Server running with Published_Mode on, or running inside the Docker image built from `Dockerfile`.
- **Rate_Limiter**: The `RateLimiter` class in `server/accounts.js`.
- **Escape_Function**: The HTML escaping function `e()` used by the App_Shell when it builds HTML strings.
- **HTML_Sink**: A place in the App_Shell that writes an HTML string into the page: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
- **User_Content**: Text that a user can set and the App_Server stores: display names, trip fields, participant names and roles, activities, meals, shopping items, gear, vehicles, events, ledger titles and notes, and AI receipt suggestions.
- **XSS_Payload_Set**: A fixed list of test strings that includes `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `'><svg onload=alert(1)>`, `javascript:alert(1)`, `` `${alert(1)}` ``, and `</textarea><script>alert(1)</script>`.
- **Security_Headers**: The response headers listed in Requirement 11.
- **OpenAI_Key**: The OpenAI API key read by `createReceiptAi` from `CAMPING_OPENAI_API_KEY` or the key file named by `CAMPING_OPENAI_API_KEY_FILE`.
- **Canary_Secret**: A fake, recognizable secret value that tests inject so that tests can search for the value in outputs.
- **Secret_Scanner**: A repository script that searches files and, where available, git history for credentials.
- **Secret_Finding**: One match reported by the Secret_Scanner: location, rule name, and redacted value.
- **Redacted_Value**: A secret shown as its first 4 characters, an ellipsis, and its last 4 characters, or as `[redacted]` when the secret is shorter than 16 characters.
- **Static_Allowlist**: The path patterns that `server/http.js` serves from the Build_Output.
- **Receipt_AI_Usage_Record**: A row in the Accounts_DB that records one receipt AI request to OpenAI: time, user ID, trip ID, model ID, prompt tokens, completion tokens, and outcome.
- **AI_Cost_Config**: The receipt AI settings for model ID, image detail level, maximum completion tokens, per-user limit, global daily limit, and global monthly limit. AI_Cost_Config is separate from the Receipt_AI_Policy: the policy decides who may use receipt AI, and AI_Cost_Config decides how much.
- **Failed_Login_Event**: A record of one `POST /api/login` request that does not start a Session.
- **Security_Event_Store**: A table in the Accounts_DB, separate from the `audit` table, that holds Failed_Login_Events and Security_Alerts.
- **Security_Alert**: A record created when failed logins cross a threshold in Requirement 23.
- **Alert_Dispatcher**: The single App_Server function through which every Security_Alert is created. The Alert_Dispatcher stores the Security_Alert, writes the alert log line, and calls each registered Alert_Notifier.
- **Alert_Notifier**: A function registered with the Alert_Dispatcher that receives each new Security_Alert, for example a future LINE webhook sender.
- **CSRF_Decision**: The decision recorded for this spec to defend Mutating_Requests with an exact `Origin` match against the Expected_Origin, a `Sec-Fetch-Site` check, JSON-only content types, and `SameSite=Strict` Session_Cookies, without a synchronizer token.
- **Admin_Page**: The `/admin` page in `src/accounts-ui.js`.
- **Dependency_Audit**: A check of every package in `package.json` and `bun.lock` for known vulnerabilities and for use in the code.
- **Security_Review**: A document in the repository that records the review method, threat model, and every finding.
- **Finding**: One entry in the Security_Review with an ID, title, severity, location, evidence, impact, recommendation, and status.
- **Security_Report**: The final deliverable document described in Requirement 26.
- **Unit_Suite**: The tests run by `bun test tests/*.test.js`.
- **E2E_Suite**: The tests run by `playwright test`.

## Requirements

### Requirement 1: Login Required for Private Pages and Protected APIs

**User Story:** As the operator, I want every private page and API to require a real login, so that nobody can see account data without signing in.

#### Acceptance Criteria

1. IF the App_Server receives a Protected_API request without a Valid_Session, THEN THE App_Server SHALL respond with status 401 and a JSON error body that contains no user ID, username, display name, trip, ledger, invite, or audit data, and SHALL leave the Accounts_DB unchanged except for rate-limit counters.
2. WHEN a visitor without a Valid_Session opens a Private_Page other than `/invite/{token}`, THE App_Shell SHALL navigate to `/login?next=<encoded path>`, where `<encoded path>` is the percent-encoded path of the Private_Page, and SHALL add no trip, ledger, invite, or admin content to the DOM before that navigation.
3. IF a request carries a Session_Cookie whose Session expiry time is equal to or earlier than the App_Server's current time, THEN THE App_Server SHALL respond exactly as the App_Server responds to a request without a Session_Cookie: status 401 for a Protected_API route, and the signed-out response for `GET /api/session`.
4. IF a request carries a session token of a user whose `deleted_at` column is not null, THEN THE App_Server SHALL reject the request with status 401, including for Sessions created before the soft-delete. *(Criteria 3 to 6 are already in place through the `sessionUser` query and `routes.logout`; this spec adds the property test of criterion 8.)*
5. WHEN a user with a Valid_Session calls `POST /api/logout`, THE App_Server SHALL delete that Session from the Accounts_DB and respond with a `Set-Cookie` header that expires the Session_Cookie (`Max-Age=0`), so that a later Protected_API request with the same token receives status 401.
6. IF `POST /api/logout` is called without a Valid_Session, THEN THE App_Server SHALL respond with a success status, expire the Session_Cookie, and delete no other Session.
7. THE Unit_Suite SHALL include a route inventory test that classifies every path and method in the Route_Table as exactly one of Public_API, Protected_API (not admin), or Admin_API, for both a Local_Mode and a Published_Mode account service, and that fails when the Route_Table contains an entry that the inventory does not list or when the inventory lists an entry that the Route_Table does not contain. The inventory SHALL classify `GET /api/invites/{token}/preview` and `POST /api/invites/{token}/register` as Public_API; `GET /api/trips/{id}/invites` and `POST /api/trips/{id}/invites/{inviteId}/revoke` as Protected_API; `GET` and `PATCH /api/admin/settings` as Admin_API; and SHALL list `POST /api/setup` as Public_API in Local_Mode and as absent in Published_Mode.
8. FOR ALL Protected_API routes and methods in the route inventory, each of the following requests SHALL receive status 401 (property test): no Session_Cookie; an empty Session_Cookie; a Session_Cookie whose length is not 64 characters (the lowercase hex encoding of a 32-byte token); a Session_Cookie containing characters outside `0-9` and `a-f`; a well-formed token that matches no Session; an expired Session; a Session of a soft-deleted user.
9. IF the `next` parameter on `/login` is anything other than a path that matches one of the Private_Page patterns exactly (for example an absolute URL, a value starting with `//` or `/\`, a `javascript:` URL, a path with a query or fragment, or any other same-origin path), THEN THE App_Shell SHALL ignore the `next` parameter after a successful login and navigate to `/{username}/home`. `safeNext` keeps accepting `/invite/{token}` paths as today (PBN 14.1 sign-in link) and is widened only to the other Private_Page patterns.
10. WHEN the App_Shell receives a 401 response from a Protected_API request that loads a Private_Page (home trip list, trip envelope, signed-in invite read, Invite_List, admin lists), THE App_Shell SHALL remove any trip, ledger, invite, or admin content from the DOM and navigate to `/login?next=<encoded path>` for the current page. WHILE the trip editor or the ledger editor holds unsaved changes, a 401 from a save request SHALL keep the existing message that asks the user to export the unsaved changes, so that no edits are lost.
11. IF the App_Shell's `GET /api/session` request fails with a network error or a status of 500 or higher while the App_Shell opens a Private_Page, THEN THE App_Shell SHALL show an error message saying the session could not be checked, offer a retry action, and render no trip, ledger, invite, or admin content. *(Already in place: `main()` in `src/accounts-ui.js` shows 暫時無法確認登入狀態 with a reload action for any session failure; this spec adds a test only.)*
12. WHEN a visitor without a Valid_Session opens `/invite/{token}` while `GET /api/session` reports `inviteRegistration: true` and the Invite_Preview request returns status 200, THE App_Shell SHALL render only the Invite_Preview fields (trip title, destination, start date, end date, inviter display name), the invite registration form, the single-use note, and a sign-in link, and SHALL render no participant list, trip state, ledger data, invite list, or admin content. *(Already in place: PBN 14.1, 15.1, 15.2; covered by `tests/invites.test.js` Property 12 and `tests/invite-registration.e2e.js`. This spec adds the XSS check of Requirement 9.6 for this page.)*
13. IF a visitor without a Valid_Session opens `/invite/{token}` and the Invite_Preview request returns status 404 or 429, or `GET /api/session` reports `inviteRegistration: false`, THEN THE App_Shell SHALL show the invalid-link page, the retry message, or the navigation to `/login?next=<encoded path>` respectively, and SHALL render no trip data. *(Already in place: PBN 15.9.)*

### Requirement 2: Password Hashing

**User Story:** As a user, I want my password stored only as a slow salted hash, so that a stolen database does not reveal my password.

#### Acceptance Criteria

1. WHEN the App_Server creates a user through `POST /api/setup`, `POST /api/register`, or `POST /api/invites/{token}/register`, or the Create_Admin_CLI creates a user, THE App_Server SHALL store in the `password_hash` column only a string in the format `scrypt$N$r$p$salt$hash`, where N is a power of 2 of at least 16384, r is 8, p is 1, salt is the base64 encoding of 16 random bytes, and hash is the base64 encoding of a 64-byte derived key.
2. THE App_Server SHALL accept a password for user creation only if the password is a string of 12 to 128 Unicode code points, inclusive.
3. IF a user creation request carries a password that is not a string or is outside 12 to 128 Unicode code points, THEN THE App_Server SHALL reject the request with status 400 and an error message stating the password length rule, and SHALL add no row to the `users` table.
4. FOR ALL passwords of 12 to 128 Unicode code points, including non-ASCII passwords, verifying the password against the hash of the same password SHALL succeed, and verifying any different password against that hash SHALL fail (round-trip property test, at least 100 generated cases).
5. FOR ALL pairs of users created with the same password, THE App_Server SHALL store two different `password_hash` strings with two different salt fields (property test, at least 100 generated cases).
6. IF a stored `password_hash` value does not split into exactly 6 `$`-separated fields, does not start with `scrypt`, has a non-integer N, r, or p, or has an empty hash field, THEN THE App_Server SHALL treat password verification for that user as failed, return the same login failure response as for a wrong password, and keep serving later requests.
7. WHEN a user registers, or attempts a successful or failed login, with a Canary_Secret of 12 to 128 characters as the password, THE Accounts_DB file and its write-ahead log file, the `audit` table, the Security_Event_Store, the App_Server log output, and the HTTP response headers and bodies SHALL contain no copy of the Canary_Secret in plain text, base64, or hex form.
8. WHEN the Security_Review inspects an existing Accounts_DB, THE Security_Review SHALL report the number of `password_hash` values that do not match the scrypt format of criterion 1 and the number of scrypt values with N below 16384, and the SHA-256 checksum of the Accounts_DB file SHALL be the same before and after the inspection.
9. THE App_Server SHALL compare a derived key with a stored hash using a constant-time comparison.
10. IF a `POST /api/login` request names a username that does not exist or belongs to a deleted user, THEN THE App_Server SHALL run one scrypt verification against a dummy hash with the parameters of criterion 1 before returning the login failure response.

### Requirement 3: Session Cookie Attributes

**User Story:** As a user, I want my session cookie protected from scripts, plain HTTP, and other sites, so that my session cannot be stolen or misused.

#### Acceptance Criteria

1. THE App_Server SHALL set every Session_Cookie with the `HttpOnly`, `SameSite=Strict`, and `Path=/` attributes, a `Max-Age` between 1 and 604800 seconds inclusive, and no `Domain` attribute.
2. WHEN the App_Server creates a Session, THE App_Server SHALL store a Session expiry time equal to the creation time plus the `Max-Age` value sent on the matching Session_Cookie, with a tolerance of 5 seconds.
3. WHILE Published_Mode is on, THE App_Server SHALL include the `Secure` attribute on every Session_Cookie set or cleared in response to a Proxied_Request. *(Already in place: PBN 5.1; `ctx.secureCookie` from `resolveRequestContext`; covered by `tests/deploy-config.test.js` Property 5 and the proxied login test in `tests/publish.test.js`.)*
4. IF the request URL protocol is `https:`, THEN THE App_Server SHALL include the `Secure` attribute on every Session_Cookie set or cleared in the response. *(Already in place: PBN 5.3; same tests.)*
5. IF the request is not a Proxied_Request in Published_Mode and the request URL protocol is `http:`, THEN THE App_Server SHALL omit the `Secure` attribute from the Session_Cookie, so that local HTTP login, including a Direct_Local_Request in Published_Mode, keeps working. *(Already in place: PBN 5.3; `Secure` is set exactly when `published && isProxied` or the URL is `https:`.)*
6. WHEN a `POST /api/logout` request is received, THE App_Server SHALL delete the Session named by the incoming Session_Cookie from the Accounts_DB and send a Session_Cookie with an empty value, `Max-Age=0`, and the same `HttpOnly`, `SameSite`, `Path`, and `Secure` attributes used to set the Session_Cookie. *(Already in place: `routes.logout` uses `cookieHeader(ctx.secureCookie, '', 0)`; this spec adds a test.)*
7. IF a `POST /api/logout` request carries no Session_Cookie or a Session_Cookie that names no Valid_Session, THEN THE App_Server SHALL send the cleared Session_Cookie described in criterion 6 and leave every other Session unchanged.
8. WHEN a login, registration, invite registration, or setup succeeds, THE App_Server SHALL delete the Session named by the incoming Session_Cookie, if one exists, and set a Session_Cookie carrying a newly generated session token that differs from the incoming token. *(Already in place: `startSession`; this spec adds a test.)*
9. IF a login, registration, invite registration, or setup fails, THEN THE App_Server SHALL leave the Session named by the incoming Session_Cookie unchanged and set no new Session_Cookie.
10. THE App_Server SHALL generate each session token from at least 32 bytes of cryptographically secure randomness, store only the SHA-256 hash of the token in the Accounts_DB, and include the raw token in no response body and no `audit` row.
11. IF a request carries a Session_Cookie whose token hash matches no Session, or matches a Session that is not a Valid_Session, THEN THE App_Server SHALL treat the request as having no Valid_Session.

### Requirement 4: Rate Limits on Login and Registration

**User Story:** As the operator, I want login and sign-up attempts limited, so that attackers cannot guess passwords or mass-create accounts.

#### Acceptance Criteria

1. WHEN a username reaches 5 counted login failures within one 15-minute window, THE App_Server SHALL respond to every further `POST /api/login` request for that username with status 429 until that window ends, regardless of Client_Address and of whether the password is correct, where the username is compared after trimming whitespace, lowercasing, and keeping the first 64 characters, and the window starts at the first counted failure and lasts 900 seconds. *(Already in place: `LIMITS.loginUser`; this spec adds a test.)*
2. WHEN a Client_Address reaches 30 counted login failures within one 15-minute window, THE App_Server SHALL respond to every further `POST /api/login` request from that Client_Address with status 429 until that window ends, for any username and regardless of whether the password is correct, where the window starts at the first counted failure and lasts 900 seconds. *(Already in place: `LIMITS.loginClient`, PBN 7.)*
3. WHEN a Client_Address reaches 20 registration attempts within one 60-minute window, THE App_Server SHALL respond to every further registration attempt from that Client_Address with status 429 until that window ends and create no user for any blocked attempt, where a registration attempt is any `POST /api/register` or `POST /api/invites/{token}/register` request that passes the Origin check, is not refused by the closed Registration_Policy, and is not blocked by the Rate_Limiter, successful or not (including requests later rejected with 400, 404, 409, 413, or 415), and the window starts at the first counted attempt and lasts 3600 seconds. A `POST /api/register` refused with 403 under the closed Registration_Policy is answered before the Rate_Limiter and is not counted. *(Already in place: PBN 10.2, 14.9; covered by the register bucket tests in `tests/publish.test.js`.)*
4. THE App_Server SHALL count invite registration requests in the same `register` bucket as `POST /api/register`, so that 20 attempts in total across both routes from one Client_Address within one 60-minute window trigger the limit in criterion 3. *(Already in place: PBN 14.9.)*
5. WHEN the App_Server responds with status 429 because of a Rate_Limiter limit (`loginUser`, `loginClient`, `register`, or `invitePreview`), THE App_Server SHALL include a `Retry-After` header whose value is the number of seconds until the blocking window ends, rounded up and at least 1, and SHALL keep the existing status and response body.
6. WHILE a login request is blocked by the Rate_Limiter, THE App_Server SHALL respond before running password hashing, start no Session, set no Session_Cookie, and leave the username and Client_Address failure counts unchanged. *(Already in place: `routes.login`; this spec adds a test.)*
7. THE Rate_Limiter SHALL key client limits on the Client_Address defined by the `publish-behind-nginx` spec, so that two visitors with different Client_Addresses behind the same nginx proxy use separate buckets. *(Already in place: PBN 7; covered by Property 9 of that spec.)*
8. THE Security_Report SHALL state that Rate_Limiter counters for login and registration are held in memory and reset when the App_Server restarts.
9. WHEN a `POST /api/login` request that the Rate_Limiter does not block starts a Session, THE App_Server SHALL reset that username's failure count to 0 and leave the Client_Address failure count unchanged. *(Already in place: `limiter.clear(userKey)`.)*
10. WHEN a `POST /api/login` request that the Rate_Limiter does not block carries a string username and a string password and ends without starting a Session, for any reason including an unknown username, a deleted user, an empty password, or a wrong password, THE App_Server SHALL add 1 to the failure count of that username and of that Client_Address. *(Already in place: `routes.login`.)*

### Requirement 5: Admin Routes Restricted to Admins

**User Story:** As the operator, I want admin pages and APIs usable only by admins, so that members cannot manage accounts or read the audit log.

#### Acceptance Criteria

1. WHEN the App_Server receives an Admin_API request with any method from a Valid_Session whose user is a Member, THE App_Server SHALL respond with status 403 and an error message saying admin permission is required, with a body containing no user, trip, or audit data, and SHALL leave the `users`, `trips`, `trip_members`, `trip_deletions`, and `audit` tables unchanged.
2. IF the App_Server receives an Admin_API request without a Valid_Session (no Session_Cookie, a token matching no Session, an expired Session, or a Session whose user is deleted), THEN THE App_Server SHALL respond with status 401, return no user, trip, or audit data, and leave the Accounts_DB unchanged.
3. THE App_Server SHALL read the requesting user's `role` and `deleted_at` values from the Accounts_DB while handling each Admin_API request, for every Route_Table entry whose path starts with `/api/admin/`, including `/api/admin/settings`, instead of using a role cached at login or Session creation. *(Already in place: `requireAdmin` reads the user through the `sessionUser` query on every call.)*
4. WHEN an Admin changes another account's role from `admin` to `member`, THE App_Server SHALL reject every Admin_API request from that account's existing Sessions with status 403, starting with the first request received after the role-change response, without requiring the demoted account to sign in again. *(Already in place: same mechanism; this spec adds a test.)*
5. WHEN a Member opens `/admin`, THE App_Shell SHALL show a message saying admin permission is required and render 0 user list rows, 0 trip list rows, and 0 audit entries.
6. THE Unit_Suite SHALL test every Admin_API path and method with a Member session, an Admin session, and no session, including `GET /api/admin/users`, `PATCH /api/admin/users/{id}`, `POST /api/admin/users/{id}/delete`, `POST /api/admin/trips/{id}/delete`, `GET /api/admin/audit`, `GET` and `PATCH /api/admin/settings`, and the security event and receipt AI usage routes added by this spec, asserting status 403 for the Member, status 401 for no session, a status other than 401 or 403 for the Admin, and an unchanged Accounts_DB (including the `settings` table) for the Member and no-session cases.
7. IF an Admin_API request from a Member passes the checks of Requirement 10.1 to 10.3 and names a target user or trip ID that does not exist, or carries a JSON body that is missing, malformed, or invalid, THEN THE App_Server SHALL respond with status 403 rather than 400, 404, or 409.
8. WHEN a visitor without a Valid_Session opens `/admin`, THE App_Shell SHALL navigate to `/login?next=%2Fadmin` as required by Requirement 1.2 and render 0 user list rows, 0 trip list rows, and 0 audit entries before that navigation.
9. THE Unit_Suite SHALL include a test that fails when the Route_Table contains a path starting with `/api/admin/` that the Admin_API tests in criterion 6 do not cover.

### Requirement 6: Users See Only Their Own Data

**User Story:** As a user, I want only the people in my trip to see my trip, so that my plans and expenses stay private.

#### Acceptance Criteria

1. IF a Member who is not a Trip_Participant sends a request with a Valid_Session to any Trip_Scoped_Route with any method, including `GET /api/trips/{id}/invites` and `POST /api/trips/{id}/invites/{inviteId}/revoke`, THEN THE App_Server SHALL return status 404 with a body containing no trip field, ledger entry, participant, or invite data, and leave the trip, ledger, and invites unchanged.
2. THE Unit_Suite SHALL include a property test that checks criterion 1 for every Trip_Scoped_Route and method, over at least 100 generated combinations of users and trips, each with at least 1 trip owner, 1 Trip_Participant from `trip_members`, and 1 Member who is not a Trip_Participant.
3. WHEN a Member lists trips, THE App_Server SHALL return every trip for which the Member is a Trip_Participant, as owner or through a `trip_members` row, and no other trip.
4. IF the App_Server rejects a trip request because the user is not a Trip_Participant, THEN THE App_Server SHALL return the same status code, response body, and set of response header names as for a trip ID that does not exist.
5. WHEN a user with a Valid_Session reads `GET /api/invites/{token}` for a Valid_Invite, or for a Used_Invite while the user is a Trip_Participant, THE App_Server SHALL return only the trip title, destination, start date, end date, and a boolean for whether the user is already a Trip_Participant, with no participant list, ledger data, invite token list, or other trip field; and WHEN any visitor reads `GET /api/invites/{token}/preview` for a Valid_Invite, THE App_Server SHALL return exactly the Invite_Preview fields. *(Already in place: PBN 15.1, 15.2, 17.4; covered by Properties 12 and 13 of that spec.)*
6. IF a user reads an invite whose token is malformed, unknown, expired, revoked, used by another account, created by a deleted account or an account that is no longer an Inviter, or attached to a deleted trip, THEN THE App_Server SHALL return status 404 with the Invalid_Invite_Message and no trip data, with the same status, body, and header names in every case, and leave the invite and trip unchanged. *(Already in place: PBN 15.3, 17.3.)*
7. WHEN a Member opens `/{username}/home` for a username other than the Member's own, including a username that does not exist, THE App_Shell SHALL show a permission message, render no trip list, and send no trip list request for that username.
8. WHEN an Admin sends a request to any Trip_Scoped_Route that is not a Participant_Only_Route for an existing trip, THE App_Server SHALL process the request with the same read and manage access as the trip owner, whether or not the Admin is a Trip_Participant. *(Already in place: `capabilities` treats `role === 'admin'` as `manage`.)*
9. THE Security_Report SHALL list Admin read and manage access to every trip as intended behavior, and SHALL list that Participant_Only_Routes return status 404 to an Admin who is not bound to a person in the trip, which keeps ledger data and receipt AI use limited to the trip's people.
10. IF a Member who is not a Trip_Participant sends `GET` or `PUT /api/trips/{id}/ledger` with a trip ID copied from a real trip, THEN THE App_Server SHALL return status 404 with no ledger data and leave the stored ledger unchanged, and THE Unit_Suite SHALL test both methods by comparing the stored ledger before and after the request.
11. IF an Admin who is not bound to a person in the trip sends a request to a Participant_Only_Route, THEN THE App_Server SHALL return status 404 with the same body as for a nonexistent trip and leave the ledger unchanged. *(Already in place: `ledgerAccess` requires `personId`; this spec adds a test.)*

### Requirement 7: Parameterized Queries

**User Story:** As the operator, I want every database query parameterized, so that user input cannot change SQL statements.

#### Acceptance Criteria

1. THE App_Server SHALL pass every value derived from a request (path segment, query string, header, cookie, or body field), and every value read back from the Accounts_DB, to SQLite only through bound statement parameters.
2. THE App_Server SHALL build SQL text only from string literals and from module-level or service-level constants whose values are string literals fixed at load time, such as `TRIP_SELECT` and `LIVE` in `server/accounts.js`.
3. WHERE a query needs a variable number of placeholders or a variable column or sort name, THE App_Server SHALL build that fragment only from `?` placeholders or from a value chosen out of a constant list of allowed identifiers, and SHALL reject the request without running the query when the identifier is not in that list.
4. THE Unit_Suite SHALL include a static check that scans every `.js` file in `server/` and fails, reporting file and line, when a `db.query`, `db.prepare`, `db.exec`, or `db.run` call builds its SQL text by concatenation or template interpolation of anything other than a constant from criterion 2 or a placeholder fragment from criterion 3.
5. THE Unit_Suite SHALL show that the static check fails on a fixture that interpolates a function parameter into SQL and passes on a fixture that interpolates only a constant from criterion 2.
6. WHEN a login, password, registration username, display name, trip title, description, note, ledger title, ledger note, or invite token contains any value from the SQL payload set (`' OR 1=1 --`, `'; DROP TABLE users; --`, `" OR ""="`, `1; DELETE FROM sessions`, `') UNION SELECT * FROM users --`, and a value containing a NUL character), THE App_Server SHALL treat the value as data, and every table row other than the single row the request creates or updates SHALL be identical before and after the request.
7. IF a `POST /api/login` request carries a username or password from the SQL payload set that does not match a stored user, THEN THE App_Server SHALL reject the login with the same response as for any other wrong credentials and create no Session.
8. IF an invite token or trip ID from the SQL payload set does not match a stored row exactly, THEN THE App_Server SHALL respond as for a nonexistent token or trip ID and expose no other row.
9. FOR ALL strings the App_Server accepts as trip titles, descriptions, notes, and ledger notes, including SQL payloads, non-BMP Unicode, and strings at the field maximum length, storing the string and reading the trip back SHALL return a byte-identical string (round-trip property).

### Requirement 8: Server-Side Validation of Every Form

**User Story:** As the operator, I want the server to validate every submitted form, so that a modified browser cannot store invalid or harmful data.

#### Acceptance Criteria

1. WHEN the App_Server receives a Mutating_Request with a body, THE App_Server SHALL check, before writing to the Accounts_DB, that the content type is `application/json`, the body is at most 1,048,576 bytes, the body parses as JSON, the parsed value is a JSON object, and every field matches the type, length or numeric range, and allowed value set recorded for that field in the Security_Review.
2. IF a Mutating_Request fails any check in criterion 1, THEN THE App_Server SHALL respond with a status from 400 to 422 (413 for the size check, 415 for the content type check) and an error message naming the failed check or field, and leave every table row unchanged.
3. IF a Mutating_Request contains several fields and at least one field fails validation, THEN THE App_Server SHALL reject the whole request and store no field from the request.
4. WHEN the App_Server stores trip state, THE App_Server SHALL remove every field that the trip state schema does not define, at every nesting level, and store the remaining fields unchanged.
5. FOR ALL generated JSON bodies sent to each mutating route in the Route_Table, at least 100 per route, THE App_Server SHALL respond with a status below 500 and leave every table unchanged whenever the status is 400 or higher (property test).
6. THE Unit_Suite SHALL call each mutating route directly with a missing required field, a wrong-type field, a string one character over its maximum length, a value outside its allowed set, invalid JSON, a JSON array, and a body of 1 MiB plus 1 byte, asserting a status from 400 to 422 (413 for the oversize case per Requirement 17) and an unchanged Accounts_DB.
7. THE Security_Review SHALL list every form in the App_Shell with the receiving route and, for each field, the type, the length or range limit, the allowed value set, and whether the field is required.

### Requirement 9: Output Escaping Against XSS

**User Story:** As a user, I want text typed by other trip members shown as text, so that nobody can run scripts in my browser.

#### Acceptance Criteria

1. THE App_Shell SHALL pass every User_Content value, and every value received from the App_Server, through the Escape_Function before writing the value into an HTML_Sink or an HTML attribute value, with exemptions only for string constants written in `src/` and for markup built solely from such constants and already-escaped values.
2. THE Escape_Function SHALL replace every `&`, `<`, `>`, `"`, `'`, and `` ` `` with an HTML character reference and leave every other character unchanged.
3. WHEN the Escape_Function receives `null` or `undefined`, THE Escape_Function SHALL return an empty string.
4. WHEN the Escape_Function receives a number or a boolean, THE Escape_Function SHALL convert the value to its string form before escaping.
5. FOR ALL strings, including the XSS_Payload_Set, empty strings, strings containing character references, and non-ASCII strings, parsing the Escape_Function output as HTML text content SHALL produce exactly one text node equal to the original string (no node for the empty string) and zero elements, and THE Unit_Suite SHALL check at least 1,000 generated strings (round-trip property).
6. WHEN User_Content fields hold each XSS_Payload_Set string, including the trip title and destination and the inviter display name shown in the Invite_Preview and the creator display name shown in the Invite_List, THE E2E_Suite SHALL load the trip page, home page, signed-in invite page, signed-out invite page (Invite_Preview and registration form), Invitation_Dialog, expenses view, and Admin_Page (including the site settings and security sections), and pass only if no dialog opens, no page error is reported, a sentinel on `window` stays unset, no `script`, `img`, `svg`, or `iframe` element exists that the test data did not create, and each payload appears as visible text exactly as stored.
7. WHEN the App_Shell renders a link whose URL comes from User_Content, THE App_Shell SHALL render the value as a link only if the trimmed value starts with `https:` (case-insensitive) or is a same-origin relative path starting with a single `/` that is not followed by `/` or `\`.
8. IF a link URL from User_Content does not meet criterion 7, including `javascript:`, `data:`, `http:`, and `//` values, THEN THE App_Shell SHALL render the value as escaped plain text without an `href` attribute.
9. THE Security_Review SHALL list every HTML_Sink in `src/` found by searching for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, and `document.write`, with file, line, and a label for each interpolated value (escaped, constant, or trusted App_Shell markup), and SHALL label zero values as unescaped User_Content.
10. THE Content-Security-Policy SHALL set `script-src` to `'self'` with neither `'unsafe-inline'` nor `'unsafe-eval'`, on Local_Mode responses and on the Published_Mode shell, whose only injected markup is the `<meta name="camping-deployment" content="published">` tag (no inline script).
11. THE Content-Security-Policy SHALL omit `'wasm-unsafe-eval'` from `script-src` and from every other directive, because the browser OCR path is removed under Requirement 22.5.

### Requirement 10: CSRF Protection

**User Story:** As a user, I want other websites unable to make my browser change my data, so that a malicious page cannot act with my session.

#### Acceptance Criteria

1. IF a Mutating_Request to any Public_API or Protected_API route has no `Origin` header, an `Origin` of `null`, or an `Origin` whose scheme, host, or port differs from the Expected_Origin, THEN THE App_Server SHALL respond with status 403 and the message 請求來源不被允許。, run no route handler, set no Session_Cookie, and leave the Accounts_DB unchanged. *(Already in place: PBN 4 in `accounts.handle`; covered by Property 6 of that spec. This spec adds the per-route test of criterion 7.)*
2. IF a Mutating_Request carries `Sec-Fetch-Site: cross-site`, THEN THE App_Server SHALL respond with status 403 and an error indicating a cross-site request, run no route handler, set no Session_Cookie, and leave the Accounts_DB unchanged, even when the `Origin` matches the Expected_Origin.
3. IF a JSON_Route receives a Mutating_Request whose `Content-Type` is absent or whose media type, compared case-insensitively and ignoring parameters, is not `application/json`, THEN THE App_Server SHALL respond with status 415, read no request body, and leave the Accounts_DB unchanged; a registration request rejected this way still counts as a `register` attempt under Requirement 4.3.
4. IF a Mutating_Request fails criterion 1 or 2, THEN THE App_Server SHALL send the 403 response before any route handler runs, and IF a Mutating_Request to a JSON_Route fails criterion 3, THEN THE App_Server SHALL send the 415 response in place of any 401 or 400 to 422 response, while keeping the earlier route-specific answers that the `publish-behind-nginx` spec defines: the closed Registration_Policy 403 for `POST /api/register` (PBN 10.2), the `register` limit 429 (PBN 14.9), and the loopback 403 for `POST /api/setup` (PBN 8.5).
5. WHEN a Mutating_Request has an `Origin` equal to the Expected_Origin, a `Sec-Fetch-Site` of `same-origin` or `none` or no `Sec-Fetch-Site` header, and for a JSON_Route the media type `application/json`, THE App_Server SHALL pass the request to the route handler without a 403 or 415 response from the CSRF checks.
6. FOR ALL GET and HEAD routes in the route inventory, a request with or without a Valid_Session SHALL leave the Accounts_DB content unchanged (property test comparing every table before and after).
7. THE Unit_Suite SHALL test every mutating route in the route inventory, in Local_Mode and in Published_Mode (Proxied_Requests with the Public_Origin as the Expected_Origin), with and without a Valid_Session, with a missing `Origin`, a `null` `Origin`, a foreign `Origin` differing only in scheme, only in host, and only in port, `Sec-Fetch-Site: cross-site` with a matching `Origin`, and for JSON_Routes the content types `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`, and no `Content-Type`, asserting the status from criteria 1 to 4 and an unchanged Accounts_DB.
8. THE App_Server SHALL set every Session_Cookie with `SameSite=Strict`, as required by Requirement 3.1, as a second CSRF defense. *(Already in place: `cookieHeader`.)*
9. THE Security_Review SHALL record the CSRF_Decision and the reasoning: the App_Shell and the API share one origin; every cookie-authenticated Mutating_Request carries a JSON body or, for receipt AI uploads, an `image/jpeg` or `image/png` body, neither of which a cross-site HTML form can send; a cross-site `fetch` with such a content type triggers a CORS preflight that Requirement 12.3 rejects; and OWASP accepts origin verification combined with `SameSite` cookies for same-origin JSON APIs that accept no cookie-authenticated form posts.
10. WHEN a Route_Table route is changed to accept a Mutating_Request body of type `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`, THE agent SHALL revisit the CSRF_Decision and record in the Security_Review whether a synchronizer token is added for that route and why.

### Requirement 11: Security Headers

**User Story:** As the operator, I want standard security headers on every response, so that browsers apply their built-in protections.

#### Acceptance Criteria

1. THE App_Server SHALL include each of these headers exactly once on every response to GET, HEAD, and Mutating_Requests: `Content-Security-Policy` (per criteria 2 and 3), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy` (per criterion 4), `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`, covering static files, App_Shell pages, the Published_Mode shell with the injected deployment meta tag, the Published_Mode `sw.js` with `const PUBLISHED=true;`, Public_API and Protected_API responses, the 403 `Forbidden host` and 400 `Bad forwarding header` responses of `resolveRequestContext`, and 400, 403, 404, 405, 413, 429, and 500 responses, including 404 responses for unknown `/api/` paths, the Published_Mode 404 for `/demo`, `/setup`, and `POST /api/setup`, and 500 responses from a throwing handler. The App_Server SHALL keep the existing `Cache-Control` values that the `publish-behind-nginx` spec relies on: `no-store` on the shell and on `/invite/{token}` pages (PBN 15.6) and `no-cache` on `sw.js` and versioned assets.
2. THE Content-Security-Policy SHALL contain `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, and `connect-src 'self'`, with no additional sources in those six directives.
3. THE Content-Security-Policy SHALL contain no `'unsafe-eval'`, no `*`, and no bare `http:` or `https:` scheme source in any directive.
4. THE `Permissions-Policy` header SHALL deny at least `camera`, `microphone`, and `geolocation` to all origins using `()`.
5. THE App_Server SHALL send `Cache-Control: no-store` exactly once on every `/api/` response, including 400, 403, 404, 405, 413, 429, and 500 responses.
6. THE Example_Nginx_Config SHALL send `Strict-Transport-Security` on HTTPS responses as defined in the `publish-behind-nginx` spec. *(Already in place: PBN 5.4 in `docs/deploy-nginx.md`; this spec adds a document check.)*
7. THE Security_Report SHALL list each Content-Security-Policy directive containing `'unsafe-inline'` or any other `'unsafe-` or `'wasm-unsafe-` keyword, with the directive, the keyword, the App_Shell feature that needs the keyword, and the remaining risk.
8. THE Unit_Suite SHALL send at least one request for each response kind in criterion 1 and assert that every applicable header from criteria 1 to 5 is present exactly once with the required value.
9. WHEN the E2E_Suite loads the login page, a Private_Page for a signed-in Member, and the Admin_Page for a signed-in Admin, THE E2E_Suite SHALL fail if the browser reports any Content-Security-Policy violation during load and normal page actions.

### Requirement 12: CORS Limited to the Site's Own Origin

**User Story:** As the operator, I want only my own site to call my API from a browser, so that other websites cannot read API responses.

#### Acceptance Criteria

1. THE App_Server SHALL serve the App_Shell and the API from the same origin.
2. THE App_Server SHALL send no `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Expose-Headers`, or `Access-Control-Max-Age` header on any response, including API, static, and error responses, whatever `Origin` the request carries or lacks. *(Already in place: no code sets these headers; this spec adds the test of criterion 7.)*
3. WHEN the App_Server receives an `OPTIONS` request for an `/api/` path, THE App_Server SHALL respond with status 405 and no `Access-Control-*` header, whether or not the path is in the Route_Table and whether or not CORS preflight headers are present.
4. WHEN the App_Server responds to an `OPTIONS` request for an `/api/` path, THE App_Server SHALL invoke no route handler, leave the Accounts_DB unchanged, and send no `Set-Cookie` header.
5. IF a Mutating_Request carries an `Origin` that differs from the Expected_Origin, THEN THE App_Server SHALL reject the request with an error response containing no `Access-Control-*` header, invoke no route handler, and leave the Accounts_DB unchanged.
6. THE Example_Nginx_Config SHALL contain no `add_header` directive that sets an `Access-Control-*` header and no directive that answers `OPTIONS` requests itself. *(Already in place: PBN 12 example; this spec adds a document check.)*
7. THE Unit_Suite SHALL send requests with a foreign `Origin`, with the Expected_Origin, and with no `Origin`, covering at least one Public_API route (including `GET /api/invites/{token}/preview`), one Protected_API route, one Admin_API route, one Static_Allowlist path, and one 404 path, in Local_Mode and Published_Mode, and check that no response contains an `Access-Control-*` header.
8. THE Unit_Suite SHALL send an `OPTIONS` request with a foreign `Origin` and `Access-Control-Request-Method: POST` to at least one Protected_API route and check for status 405, no `Access-Control-*` header, no `Set-Cookie` header, and an unchanged Accounts_DB.

### Requirement 13: API Keys Kept Off the Frontend

**User Story:** As the operator, I want the OpenAI key used only on the server, so that visitors cannot copy and abuse it.

#### Acceptance Criteria

1. THE App_Server SHALL read the OpenAI_Key only from `CAMPING_OPENAI_API_KEY` or from the key file named by `CAMPING_OPENAI_API_KEY_FILE` (default `.secrets/openai_api_key`), and SHALL send the OpenAI_Key only in the `Authorization` header of requests to the origin `https://api.openai.com`, with redirects refused. *(Already in place: `createReceiptAi`; this spec adds a test.)*
2. WHEN the App_Server runs with a Canary_Secret in OpenAI key format as the OpenAI_Key, THE headers and bodies of responses from every Route_Table route and Static_Allowlist path, including error responses and the receipt AI status response, SHALL contain neither the full Canary_Secret nor any 8-character substring of the part after the `sk-` prefix.
3. WHEN the Build_Script runs with a Canary_Secret in `CAMPING_OPENAI_API_KEY` and a distinct Canary_Secret in every other `CAMPING_` environment variable, THE Build_Output, including the bundle, the assets, and `sw.js`, SHALL contain no copy of any Canary_Secret.
4. IF the OpenAI API returns a non-success status, a body larger than 256 KiB, or a body not in the expected receipt shape, THEN THE App_Server SHALL respond with its own error message saying receipt recognition failed, forward no part of the OpenAI response body or headers, and leave the ledger unchanged.
5. IF the OpenAI request fails at the network level or receives no response within 55 seconds, THEN THE App_Server SHALL cancel the request, respond with its own error message saying recognition failed, and leave the ledger unchanged.
6. WHEN the App_Server runs with a Canary_Secret as the OpenAI_Key and handles startup, a successful request, an OpenAI error, and a timeout, THE App_Server SHALL write no copy of the Canary_Secret, and no 8-character substring of the part after `sk-`, to stdout, stderr, the `audit` table, or the Security_Event_Store.
7. IF neither `CAMPING_OPENAI_API_KEY` nor the key file provides a value in OpenAI key format (`sk-` followed by at least 20 characters from letters, digits, `_`, and `-`, after trimming surrounding whitespace), THEN THE App_Server SHALL report receipt AI as disabled in the receipt AI status response (with `disabledReason: 'unconfigured'` unless the Receipt_AI_Policy already excludes the account, in which case `disabledReason: 'policy'` per PBN 11.4), reject recognition requests with an error saying receipt AI is unavailable, and send no request to `api.openai.com`. *(Already in place: `createReceiptAi` and the Receipt_AI_Decision; this spec adds a test.)*
8. THE Content-Security-Policy `connect-src` directive on every App_Shell page SHALL list only `'self'`, with no `api.openai.com`, `*.openai.com`, `*`, or scheme-only source.
9. THE App_Shell source and the Build_Output SHALL contain no reference to `api.openai.com` and no read of `CAMPING_OPENAI_API_KEY` or `CAMPING_OPENAI_API_KEY_FILE`.

### Requirement 14: No Secrets in Public Environment Variables

**User Story:** As the operator, I want to know that no secret is exposed through environment variables that reach the browser or the image metadata, so that configuration does not leak keys.

#### Acceptance Criteria

1. THE Security_Review SHALL list every environment variable read in `server/`, `scripts/`, `src/`, `Dockerfile`, and `docker-compose.yml`, with the name, every file and line where the variable is read, the default value or "none", secret or non-secret, and server-only or reaching the Build_Output.
2. THE Security_Review SHALL mark a variable as secret when the variable's value is a credential, an API key, a session or signing secret, or a path to a file holding one of these, and SHALL mark every other variable as non-secret.
3. THE Build_Script SHALL inline no environment variable into the Build_Output except `NODE_ENV`, and SHALL inline `NODE_ENV` only as the literal `development` or `production`.
4. WHEN the Unit_Suite runs the Build_Script with `CAMPING_OPENAI_API_KEY` and every other secret variable set to a Canary_Secret, THE Unit_Suite SHALL fail if any Build_Output file contains the Canary_Secret.
5. THE `Dockerfile` and `docker-compose.yml` SHALL set no secret value in `ENV`, `ARG`, `environment`, `build.args`, or labels, where a secret value is any non-empty value for a secret variable or any value matching a Secret_Scanner rule.
6. THE `docker-compose.yml` SHALL provide the OpenAI_Key only as a mounted file whose container path is passed in `CAMPING_OPENAI_API_KEY_FILE`, and SHALL leave `CAMPING_OPENAI_API_KEY` unset.
7. IF a file named `.env.example` exists, THEN THE file SHALL give every variable an empty value or an angle-bracket placeholder such as `<your-openai-key>`, and SHALL contain no value matching a Secret_Scanner rule.
8. THE README SHALL recommend `CAMPING_OPENAI_API_KEY_FILE` over `CAMPING_OPENAI_API_KEY`, and SHALL explain that environment values are visible to `docker inspect` and process listings and that `ARG` values are visible in image history.
9. THE Unit_Suite SHALL include a check that fails when `Dockerfile`, `docker-compose.yml`, or `.env.example` assigns a value matching a Secret_Scanner rule, printing file, line, rule, and Redacted_Value and never the full value.
10. WHEN the check in criterion 9 runs against the repository after this spec is implemented, THE Unit_Suite SHALL report zero matches and pass.

### Requirement 15: Secret Scanning of Files and Git History

**User Story:** As the operator, I want my repository scanned for leaked secrets, so that I know whether any key was exposed.

#### Acceptance Criteria

1. THE Secret_Scanner SHALL scan every workspace file outside `node_modules/`, including ignored files under `.secrets/`, `data/`, and the Build_Output, and binary files such as the Accounts_DB, up to 50 MB per file, and SHALL list each file skipped for exceeding 50 MB.
2. WHERE the scanned directory is a git repository, THE Secret_Scanner SHALL scan every commit reachable from all local branches, remote-tracking branches, and tags, including content deleted in later commits, and report each history Secret_Finding with the full commit hash and path.
3. IF the scanned directory is not a git repository, THEN THE Secret_Scanner SHALL scan files per criterion 1, report that git history was not scanned, and print the command for scanning history in the real repository clone, and the missing history SHALL NOT by itself change the exit code.
4. THE Secret_Scanner SHALL detect at least: OpenAI keys (`sk-` or `sk-proj-` followed by at least 20 key characters), AWS access key IDs (`AKIA` or `ASIA` followed by 16 uppercase letters or digits), PEM private key blocks, bearer tokens (`Bearer ` followed by at least 20 characters), credentials embedded in URLs with a non-empty password, and values of at least 20 characters with a Shannon entropy of at least 3.5 bits per character assigned to names containing `key`, `secret`, `token`, or `password` (case-insensitive).
5. THE Secret_Scanner SHALL show every Secret_Finding with its location (path and 1-based line, or commit hash and path), rule name, and Redacted_Value, and no full secret SHALL appear in stdout, stderr, or any file the Secret_Scanner writes.
6. WHEN the Secret_Scanner finishes with at least one Secret_Finding that is not on the allowlist, THE Secret_Scanner SHALL exit with code 1.
7. THE Secret_Scanner SHALL accept an allowlist whose entries contain either the exact fake value or a rule-and-path combination plus a non-empty reason, SHALL exclude allowlisted matches from the failure count, and SHALL report the number of allowlisted matches.
8. THE Unit_Suite SHALL test that a planted fake key is reported with the correct file, line, and rule and exit code 1, that the output lacks the full key, that a clean directory gives no Secret_Finding and exit code 0, and that an allowlisted planted value gives exit code 0.
9. THE Security_Report SHALL state whether `.secrets/openai_api_key` exists in the workspace, whether `.gitignore` and `.dockerignore` each exclude the file, and whether any commit contained the file or that git history was not scanned.
10. WHEN the Secret_Scanner finishes with no Secret_Finding outside the allowlist, THE Secret_Scanner SHALL exit with code 0 and print the number of files scanned, commits scanned, and allowlisted matches.
11. IF the Secret_Scanner cannot complete the scan because a file is unreadable or a git command fails, THEN THE Secret_Scanner SHALL print which path or command failed, exit with code 2, and report the scan as incomplete.
12. IF an allowlist entry has a missing or empty reason, THEN THE Secret_Scanner SHALL print which entry is invalid and exit with code 2 without scanning.

### Requirement 16: Removal and Rotation of Leaked Keys

**User Story:** As the operator, I want any leaked key removed from the code and clear steps to replace it, so that a leaked key stops working.

#### Acceptance Criteria

1. WHEN the Secret_Scanner reports a real secret in a tracked file or a Build_Output file, THE agent SHALL replace the value with a reference to the key file or an environment variable, so that a re-scan reports zero Secret_Findings for that secret.
2. WHEN the agent removes a secret from a file, THE agent SHALL leave the file loadable by the App_Server, the Build_Script, and the Unit_Suite, and the Unit_Suite SHALL give the same result as before the removal.
3. IF the agent cannot tell whether a Secret_Finding is a real secret or a Canary_Secret, fixture, or placeholder, THEN THE agent SHALL treat the Secret_Finding as a real secret and record the Secret_Finding in the Security_Report as unconfirmed.
4. THE Security_Report SHALL list each leaked credential with the provider, file and line (or commit ID), Redacted_Value, and the steps to revoke and replace the credential, and SHALL show each credential only as a Redacted_Value.
5. THE Security_Report SHALL state that the operator must revoke leaked keys at the provider and that the agent did not revoke, rotate, or test any key against the provider.
6. WHERE a secret is found in git history, THE Security_Report SHALL give history-rewrite instructions naming each affected commit ID, state that rewriting history does not replace revocation, and state that the agent did not rewrite history or push.
7. WHILE `CAMPING_OPENAI_API_KEY` is unset or empty, WHEN the operator writes a new OpenAI_Key to the key file named by `CAMPING_OPENAI_API_KEY_FILE` (default `.secrets/openai_api_key`) and restarts the App_Server, THE App_Server SHALL send the new OpenAI_Key, trimmed of surrounding whitespace, on the next receipt AI request without a code change.
8. WHEN the Secret_Scanner finds no leaked secret, THE Security_Report SHALL state that no rotation is required based on the scanned scope, naming the scanned paths, whether git history was scanned, and the scanned HEAD commit ID when a git repository was scanned.

### Requirement 17: Upload Type and Size Limits

**User Story:** As the operator, I want uploads limited by type and size, so that large or disguised files cannot exhaust the server or reach OpenAI.

#### Acceptance Criteria

1. WHEN the App_Server receives a receipt AI upload whose `Content-Type` is `image/jpeg` or `image/png` and whose file signature identifies the same format, THE App_Server SHALL accept the upload for further validation. *(Criteria 1 to 4 and 6 are already in place in `validateAiImage`, `readLimitedBytes`, and `readJson`; this spec adds the property test of criterion 5 and boundary tests.)*
2. IF a receipt AI upload has a missing or different `Content-Type`, a file signature that is not JPEG or PNG, or a file signature whose format differs from the `Content-Type` format, THEN THE App_Server SHALL respond with status 415, call no OpenAI API, and create no Receipt_AI_Usage_Record.
3. IF a receipt AI upload exceeds 3,670,016 bytes (3.5 MiB) by the `Content-Length` header or by the bytes read, THEN THE App_Server SHALL stop reading within 64 KiB past the limit, respond with status 413, and call no OpenAI API, and an upload of exactly 3,670,016 bytes SHALL pass the size check.
4. IF a receipt AI image has a width or height of 0 or over 8000 pixels, more than 20,000,000 pixels, or is truncated (a JPEG that does not end with the EOI marker `FF D9`, or a PNG whose final chunk is not `IEND`), THEN THE App_Server SHALL respond with status 400 without calling OpenAI.
5. FOR ALL byte arrays that are not complete JPEG or PNG images (empty arrays, a valid signature followed by random bytes, and valid images truncated at any offset), the receipt image validation SHALL reject the bytes, and FOR ALL complete JPEG or PNG images within the limits of criteria 3 and 4, the receipt image validation SHALL accept the bytes (property test, at least 100 cases).
6. IF a JSON request body exceeds 1,048,576 bytes by the `Content-Length` header or by the bytes read, THEN THE App_Server SHALL stop reading, respond with status 413, and leave the Accounts_DB unchanged.
7. THE App_Server SHALL keep the `Bun.serve` request body limit (`maxRequestBodySize`) at 4,194,304 bytes or less. *(Already in place: `scripts/serve.mjs`; this spec adds a source check.)*
8. THE App_Server SHALL keep receipt images in memory only and write no receipt image bytes to disk, the Accounts_DB, logs, or temporary files. *(Already in place; the Receipt_AI_Usage_Record of Requirement 18 stores no image bytes.)*
9. WHEN a user selects a file for trip import or ledger import, THE App_Shell SHALL check the file size before reading the file and read only files of 1,048,576 bytes or less.
10. IF a selected import file is larger than 1,048,576 bytes, THEN THE App_Shell SHALL leave the file unread, show an error naming the 1 MiB limit, send no import request, and leave trip and ledger data unchanged.
11. THE Example_Nginx_Config SHALL set `client_max_body_size` to 4 MiB or less. *(Already in place: PBN 12.5; this spec adds a document check.)*
12. THE receipt image checks of criteria 1 to 4 SHALL run after the Receipt_AI_Decision allows the request, so that a request refused by the Receipt_AI_Policy (PBN 11.2, 11.3) gets the policy status without reading the image. *(Already in place: `recognizeReceiptAi` order.)*

### Requirement 18: OpenAI Cost Controls

**User Story:** As the operator, I want OpenAI spending capped and visible, so that receipt recognition cannot produce an unexpected bill.

#### Acceptance Criteria

1. WHEN the App_Server starts, THE Startup_Validator SHALL read each AI_Cost_Config value from its environment variable (the model ID from the existing `CAMPING_OPENAI_MODEL_ID`; the other variable names are chosen in the design with the `CAMPING_` prefix), using these defaults when a variable is unset or empty: model `gpt-6-luna`, image detail `high`, maximum completion tokens 6000, 10 requests per user per rolling 15 minutes, 100 requests per UTC day globally, and 1000 requests per UTC month globally.
2. IF an AI_Cost_Config value is outside its allowed range at startup, THEN THE Startup_Validator SHALL throw a ConfigError naming the setting and the allowed range, so that `scripts/serve.mjs` prints `Configuration error: <message>` and exits with code 1 before listening, in both Local_Mode and Published_Mode, where the ranges are: model ID `gpt-` followed by 1 to 80 characters from letters, digits, `.`, `_`, and `-`; image detail `low`, `high`, or `auto`; maximum completion tokens an integer from 1 to 16000; per-user limit an integer from 1 to 100; daily limit an integer from 1 to 10000; monthly limit an integer from 1 to 100000; and per-user limit ≤ daily limit ≤ monthly limit.
3. THE App_Server SHALL count a receipt AI request toward the limits only when the Receipt_AI_Decision is `allow`, the image passes Requirement 17, and the App_Server sends the request to OpenAI, and SHALL store the counts in the Accounts_DB so that the counts survive App_Server restarts, with day and month measured as UTC calendar periods.
4. IF a receipt AI request that the Receipt_AI_Decision allows would make the user's 15-minute count, the UTC day count, or the UTC month count exceed its limit, THEN THE App_Server SHALL respond with status 429 and a `Retry-After` header giving the whole number of seconds (at least 1) until the request would fit all three limits, and SHALL call no OpenAI API, increase no count, and write no Receipt_AI_Usage_Record.
5. WHEN the App_Server finishes an OpenAI request, whether the request succeeds, fails, or times out after 55 seconds, THE App_Server SHALL leave exactly one Receipt_AI_Usage_Record for that request with outcome `success`, `error`, or `timeout`, taking token counts from `usage.prompt_tokens` and `usage.completion_tokens` and recording 0 for each value that is absent.
6. WHEN an Admin opens the Admin_Page, THE Admin_Page SHALL show, next to the existing Receipt_AI_Policy control (PBN 11.11), the receipt AI request count, prompt token total, and completion token total for the current UTC day and the current UTC month, plus the configured limits, showing 0 when no Receipt_AI_Usage_Record exists for a period.
7. THE App_Server SHALL send each receipt to OpenAI at most once per user request and SHALL retry no failed, timed-out, or rejected request automatically. *(Already in place: `recognize` calls `fetch` once; this spec adds a test.)*
8. IF a receipt AI request arrives while the user already has 1 receipt AI request in progress, or while 2 receipt AI requests are in progress in total, THEN THE App_Server SHALL respond with status 429 without calling OpenAI or increasing any count. *(Already in place: the in-memory `aiActive` map; concurrency is not persisted.)*
9. IF the App_Server cannot read or update the receipt AI counts in the Accounts_DB, THEN THE App_Server SHALL reject the receipt AI request with status 503 and an error saying the service is unavailable and call no OpenAI API.
10. THE Security_Report SHALL list the configured model, the input and output token prices from the OpenAI pricing page with the date checked and the source link, and the estimated maximum cost per request, per day, and per month, calculated from the configured maximum completion tokens, image detail, and daily and monthly limits.
11. THE Security_Report SHALL recommend that the operator set a monthly budget and usage limit for the OpenAI project in the OpenAI dashboard.
12. WHILE the Receipt_AI_Policy is `off`, or is `admins` for a Member, THE App_Server SHALL answer recognition requests with the PBN 11.2 or 11.3 status before any AI_Cost_Config limit is checked, and SHALL increase no count. *(Order already in place through `authorize()`; this spec keeps it when the limits move to the Accounts_DB.)*
13. THE App_Server SHALL keep the policy re-check that `authorize()` performs after the upload and after the OpenAI response (PBN 11.8), and a request refused by that re-check after the OpenAI call SHALL keep its Receipt_AI_Usage_Record, because the OpenAI call was made.
14. THE App_Server SHALL send the configured model ID, image detail, and maximum completion tokens in every OpenAI request, and the receipt AI status response SHALL report the configured model ID only when the Receipt_AI_Decision is `allow` (PBN 11.4).

### Requirement 19: Debug Output Off in Production

**User Story:** As the operator, I want production to hide internal details, so that errors do not help an attacker.

#### Acceptance Criteria

1. IF a request to any `/api/` route or Static_Allowlist path throws an uncaught error, THEN THE App_Server SHALL respond with a server error status and one fixed generic message, with no stack trace, SQL text, file path, table or column name, environment value, or exception message in the body or headers.
2. IF a route handler raises an intended error (validation failure, missing Valid_Session, insufficient role, or rate limit), THEN THE App_Server SHALL keep the existing client error response, with no stack trace, SQL text, or file path.
3. IF the App_Server catches an uncaught error, in `accounts.handle` or in the `server/http.js` handler, THEN THE App_Server SHALL write one log line containing only the time, the method, the path without query string, and the error name, leaving out request bodies, query strings, cookies, session tokens, passwords, invite tokens, and the OpenAI_Key.
4. WHEN the Build_Script finishes, THE Build_Output SHALL contain no `.map` file and no file containing `sourceMappingURL`.
5. THE `Dockerfile` command and the `start` script in `package.json` SHALL start Bun without `--inspect`, `--inspect-brk`, `--inspect-wait`, `--hot`, or `--watch`. *(Already in place; this spec adds a source check.)*
6. WHILE the App_Server runs as a Production_Deployment, THE Route_Table and the Static_Allowlist SHALL contain no testing, debugging, or diagnostic route, including any path with a `test`, `debug`, `diag`, `__`, or `dev` segment and any route that resets, seeds, or dumps the Accounts_DB; in Published_Mode the Route_Table also contains no `/api/setup` and the static routes serve no `/demo` or `/setup` page (PBN 8.1, 8.2, 9.1). *(Already in place; this spec adds the inventory check.)*
7. WHEN the Unit_Suite forces an uncaught error whose message, file path, and SQL text each contain a Canary_Secret, THE Unit_Suite SHALL check for a server error status, a body equal to the generic message, and no Canary_Secret in any response body or header.
8. WHEN the Unit_Suite forces an uncaught error on a request whose body, cookie, and query string each contain a Canary_Secret, THE Unit_Suite SHALL check that the log contains the error name and no Canary_Secret.
9. WHEN the Unit_Suite runs, THE Unit_Suite SHALL run the Build_Script into a temporary directory and check criterion 4.

### Requirement 20: Sensitive Files Not Publicly Reachable

**User Story:** As the operator, I want files like `.env`, keys, and the database unreachable from the web and absent from the image, so that they cannot be downloaded.

#### Acceptance Criteria

1. WHEN the App_Server receives a GET or HEAD request for `/.env`, `/.env.local`, `/.secrets/openai_api_key`, `/data/accounts.sqlite`, `/data/accounts.sqlite-wal`, `/data/accounts.sqlite-shm`, `/package.json`, `/bun.lock`, `/Dockerfile`, `/server/accounts.js`, `/.git/config`, or `/.kiro/`, or a case variant such as `/.ENV`, THE App_Server SHALL respond with status 404 or 403 and no bytes of the file. *(Criteria 1 to 3 are already in place through the Static_Allowlist and the `root` prefix check in `server/http.js`; this spec adds the tests of criterion 10.)*
2. WHEN the App_Server receives a request for a path that the Static_Allowlist does not match, THE App_Server SHALL respond with the same status whether or not a file exists at that path.
3. IF a request path contains a traversal sequence (literal `../`, `%2e%2e/`, `..%2f`, `%252e%252e%252f`, a backslash or `%5c`, or `%00`), THEN THE App_Server SHALL respond with status 400, 403, or 404, serve no file outside the Build_Output, and keep serving later requests.
4. WHEN the Build_Script completes, THE Build_Output SHALL contain at any depth no `.env` or `.env.*` file, no `.secrets`, `.git`, or `.kiro` directory, no `.sqlite`, `.sqlite-wal`, `.sqlite-shm`, or `.db` file, no `.pem`, `.key`, `.p12`, or `.pfx` file, no `server/` directory, and no `package.json` or `bun.lock` file.
5. THE `.dockerignore` file SHALL exclude (all present today except `.kiro`) `.git`, `.kiro`, `.env`, `.env.*`, `.secrets/`, `data`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db`, `*.pem`, `*.key`, `*.p12`, and `*.pfx`.
6. THE runtime stage of the `Dockerfile` SHALL copy only the Build_Output, `server/`, `src/`, `scripts/serve.mjs`, and production `node_modules`, with no `COPY` or `ADD` of the whole build context (`.`). *(Already in place; this spec adds a source check.)*
7. THE `.gitignore` file SHALL exclude `.env`, `.env.*`, `.secrets/`, `data/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, and `*.db`. *(Already in place; this spec adds a source check.)*
8. THE Example_Nginx_Config SHALL proxy every request to the App_Server without serving files from disk (already in place, PBN 12.2), and SHALL return 404 for any path with a dot-prefixed segment anywhere in the path, except paths starting with `/.well-known/`, without changing the PBN 12 server blocks, redirects, HSTS header, forwarding headers, or timeouts.
9. IF the resolved absolute Accounts_DB path, after resolving relative segments and symlinks, is inside the Build_Output (the directory named by `CAMPING_DIST`, default `dist`) or any directory named `dist` or `public`, THEN THE App_Server SHALL exit at startup with a non-zero exit code and an error saying the database path is publicly servable, without creating or opening the database and without listening on a port.
10. THE Unit_Suite SHALL test each path in criteria 1 and 3, the equal-status behavior of criterion 2 with one existing and one missing non-allowlisted file, the Build_Output contents of criterion 4 after a fresh build, and the startup refusal of criterion 9 for a Build_Output path and a `public` path.

### Requirement 21: Update Packages With Known Vulnerabilities

**User Story:** As the operator, I want dependencies free of known vulnerabilities, so that a third-party bug does not expose the site.

#### Acceptance Criteria

1. THE Dependency_Audit SHALL check every package in `bun.lock`, direct and transitive, against at least one public vulnerability advisory database, and record for each advisory the advisory ID, package, installed version, severity, and fixed version ("none" when no fix exists).
2. THE Dependency_Audit SHALL record the advisory database used, the date and time of the check, and the number of packages checked, including when zero advisories are found.
3. IF the advisory database cannot be reached or the audit command ends with an error, THEN THE agent SHALL record the Dependency_Audit as incomplete in the Security_Report with the error, and SHALL NOT record the Dependency_Audit as passed.
4. WHEN an advisory has a fixed version within the installed major version, THE agent SHALL update the package to the lowest such fixed version and update `bun.lock`.
5. WHERE an updated package is pinned in the Build_Script, THE agent SHALL change that pin to exactly match the updated version.
6. IF an advisory has no fixed version or the fix needs a new major version, THEN THE Security_Report SHALL record the package, the advisory ID, whether the vulnerable code is reachable from the App_Server or the App_Shell with evidence, and one decision out of upgrade major version, replace, remove, or accept with a reason.
7. THE Dependency_Audit SHALL compare the Bun version in every `FROM` line of the `Dockerfile` with the latest patch release of the same major.minor version, recording the current version, the latest version, and the date checked.
8. IF a newer Bun patch release of the same major.minor version exists, THEN THE agent SHALL update every `FROM` line of the `Dockerfile` to that patch release.
9. WHEN a package or the Bun base image is updated, THE agent SHALL run the Build_Script, the Unit_Suite, and the E2E_Suite and record each result and the failing test count in the Security_Report.
10. IF the Build_Script, the Unit_Suite, or the E2E_Suite fails after an update, THEN THE agent SHALL fix the cause and rerun all three until all three pass, or revert the update and record the advisory under criterion 6 with the failure as the reason.
11. WHEN all updates are applied, THE agent SHALL rerun the Dependency_Audit and record that no advisory with a same-major fixed version remains, apart from the advisories recorded under criterion 6.

### Requirement 22: Remove Unused Packages

**User Story:** As the operator, I want unused packages removed, so that the app carries less code that could be vulnerable.

#### Acceptance Criteria

1. THE Dependency_Audit SHALL classify every package in `dependencies` or `devDependencies` as exactly one of browser bundle, Build_Script, tests only, or unused, listing the file and line or the copy-list entry as evidence, and SHALL classify a package with no such evidence as unused.
2. WHEN a package is classified as unused, THE agent SHALL remove the package from `package.json` and regenerate `bun.lock`, leaving no direct entry for the package and no transitive package that only the removed package required.
3. WHEN a package in `dependencies` is used by tests only, THE agent SHALL move the package to `devDependencies` with the version string unchanged.
4. THE Dependency_Audit SHALL report yes or no, with file and line evidence, whether the App_Shell reaches the browser OCR path from `src/entry.js` through static or dynamic imports, where the browser OCR path consists of `recognizeReceipt` in `src/receipt-ocr.js`, the `tesseract.js`, `tesseract.js-core`, `@tesseract.js-data/chi_tra`, and `@tesseract.js-data/eng` packages, the OCR copy step in the Build_Script and the `assets/ocr/` entries in `sw.js`, and `'wasm-unsafe-eval'` in the Content-Security-Policy.
5. THE agent SHALL keep the generated `sw.js` starting with the exact literal `const PUBLISHED=false;` and the `/demo` navigation guard that the `publish-behind-nginx` spec relies on (PBN 9.3, 9.6), and SHALL remove the browser OCR path: the `tesseract.js`, `tesseract.js-core`, `@tesseract.js-data/chi_tra`, and `@tesseract.js-data/eng` packages, the OCR copy step in the Build_Script and the `assets/ocr/` output, the `assets/ocr/` paths in `sw.js` and in the Static_Allowlist, the OCR-only code and tests, `'wasm-unsafe-eval'` in the Content-Security-Policy, and the Tesseract licensing sentence in `README.md`, while keeping every image validation function imported by `src/receipt-ai-client.js` or `server/receipt-ai.js` together with the tests of those functions.
6. THE agent SHALL remove every reference to environment variables that no file in `server/`, `scripts/serve.mjs`, or `Dockerfile` reads, including `CAMPING_BEDROCK_REGION`, `CAMPING_BEDROCK_MODEL_ID`, and `CAMPING_BEDROCK_API_KEY` in `scripts/check-accounts.mjs`, so that a case-insensitive search for `CAMPING_BEDROCK` outside `.kiro/`, `node_modules/`, and the Build_Output returns zero matches.
7. WHEN a package is removed or moved, THE agent SHALL run the Build_Script, the Unit_Suite, and the E2E_Suite and record the command, exit code, and passed, failed, and skipped counts in the Security_Review.
8. IF the Build_Script, the Unit_Suite, or the E2E_Suite fails after a removal or move, THEN THE agent SHALL restore the package entry in `package.json` and `bun.lock`, rerun the failed command, and record the package, command, and error as an open Finding.

### Requirement 23: Failed Login Logging and Admin Alerts

**User Story:** As the admin, I want failed logins recorded and to be alerted when they spike, so that I notice password-guessing attacks.

#### Acceptance Criteria

1. WHEN a `POST /api/login` request that passes the checks of Requirement 10.1 and 10.2 does not start a Session, THE App_Server SHALL write exactly one Failed_Login_Event with the time in epoch milliseconds, the Client_Address as resolved by the `publish-behind-nginx` spec, the submitted username, and one reason: `invalid_input` when the content type is not JSON, the body exceeds 1 MiB or is not valid JSON, or the username or password is missing or not a string; `rate_limited` when a rate-limit window blocks the username or the Client_Address; `deleted_account` when the username matches a deleted user and the password is correct; and `bad_credentials` in every other case, including an unknown username and a wrong password; for `rate_limited` requests, criterion 5 limits the writes to one event per blocked key per window.
2. IF the submitted username is missing, is not a string, or after trimming and lowercasing does not match the username format of `validateUsername` in `server/accounts.js` (3 to 32 characters, starting with `a`–`z`, containing only `a`–`z`, `0`–`9`, and hyphens), THEN THE App_Server SHALL store the username as `(invalid)` in the Failed_Login_Event.
3. THE App_Server SHALL store no password, password fragment, or session token in the Security_Event_Store, and a Canary_Secret submitted as the password or as an out-of-format username SHALL appear nowhere in the Security_Event_Store.
4. THE App_Server SHALL keep at most 5000 Failed_Login_Events and at most 1000 Security_Alerts, removing the oldest Failed_Login_Events first and the oldest acknowledged Security_Alerts before any unacknowledged Security_Alert, and SHALL leave the `audit` table unchanged when removing these records.
5. WHILE a rate-limit window blocks a username or a Client_Address, THE App_Server SHALL write at most one `rate_limited` Failed_Login_Event per blocked key per window, and SHALL send the same response status and body for every blocked request in that window.
6. WHEN a new Failed_Login_Event brings the count for one username other than `(invalid)` to 5 or more within the 900 seconds ending at that event, or brings the count for all usernames including `(invalid)` to 20 or more within the same span, THE App_Server SHALL create one per-username or global Security_Alert, and SHALL create no further Security_Alert of the same type for the same username (or `(all)`) until 15 minutes after the previous one.
7. WHEN the App_Server creates a Security_Alert, THE App_Server SHALL write exactly one log line with the alert type, the username or `(all)`, the count, and the window start and end, containing no password and no out-of-format username.
8. WHEN an Admin opens the Admin_Page while 1 or more unacknowledged Security_Alerts exist, THE Admin_Page SHALL show a banner with the number of unacknowledged Security_Alerts and a newest-first list with the creation time, the username or `(all)`, the triggering Client_Address, and the count for each.
9. IF no unacknowledged Security_Alert exists when an Admin opens the Admin_Page, THEN THE Admin_Page SHALL show no Security_Alert banner.
10. WHEN an Admin acknowledges an unacknowledged Security_Alert, THE App_Server SHALL mark the Security_Alert as acknowledged with the time and write one audit entry naming the Admin and the Security_Alert, and THE Admin_Page SHALL remove the Security_Alert from the list and lower the banner count by 1 without a page reload, hiding the banner at 0.
11. WHEN an Admin opens the Admin_Page, THE Admin_Page SHALL show the 200 most recent Failed_Login_Events, or all of them if fewer exist, newest first, with time, username, Client_Address, and reason.
12. THE App_Server SHALL serve Failed_Login_Events and Security_Alerts only through the Admin_API.
13. IF a read or acknowledgment request for Failed_Login_Events or Security_Alerts comes without a Valid_Session or from a user who is not an Admin, THEN THE App_Server SHALL reject the request with status 401 or 403 respectively, return no event or alert data, and leave every Security_Alert unchanged.
14. IF an Admin acknowledges a Security_Alert ID that does not exist or is already acknowledged, THEN THE App_Server SHALL return an error saying the Security_Alert was not found or is already acknowledged, leave the Security_Alert unchanged, and write no audit entry.
15. IF writing a Failed_Login_Event or a Security_Alert fails, THEN THE App_Server SHALL return the same login response as when the write succeeds, and write one log line noting the failed write, with no password and no out-of-format username.
16. THE App_Server SHALL create every Security_Alert through the Alert_Dispatcher, which stores the Security_Alert, writes the log line of criterion 7, and then passes the stored Security_Alert to each registered Alert_Notifier, so that a later Alert_Notifier such as a LINE webhook can be registered without changing the alert detection logic of criterion 6.
17. IF an Alert_Notifier throws, rejects, or has not finished, THEN THE App_Server SHALL send the same login response status and body as with no Alert_Notifier registered, without waiting for any Alert_Notifier to finish, keep the stored Security_Alert, call the remaining Alert_Notifiers, and write one log line naming the failed Alert_Notifier and the error name, with no password and no out-of-format username.
18. THE Unit_Suite SHALL register a throwing Alert_Notifier and a never-resolving Alert_Notifier, trigger a Security_Alert, and check that the login response is unchanged, the Security_Alert is stored, and a recording Alert_Notifier registered after them receives the Security_Alert exactly once.

### Requirement 24: Full Security Review

**User Story:** As the operator, I want a full review of the app's security, so that problems outside my list are found too.

#### Acceptance Criteria

1. THE Security_Review SHALL record the review method (files inspected, tools and commands run, and date) and a threat model naming the assets (accounts, sessions, trip data, ledger data, receipt images, the OpenAI_Key, the Accounts_DB), the actors (anonymous visitor, Member, Trip_Participant, Admin, operator), and the entry points (each route in the route inventory, Static_Allowlist files, the service worker, nginx, and the Docker image), stating for each entry point which actors reach the entry point and which assets the entry point exposes.
2. THE Security_Review SHALL contain one section for each OWASP Top 10 (2021) category A01 to A10, each listing the category's Finding IDs or, when no Finding applies, the control and file location that prevents the risk.
3. THE Security_Review SHALL contain one section each for invite token handling (the signed-out Invite_Preview, invite registration, single use, the Invite_List, and revoke by Invite_ID), first-admin setup through `POST /api/setup` in Local_Mode and the Create_Admin_CLI in Published_Mode, the deployment configuration and its Startup_Validator, the service worker cache of Private_Page and `/api/` responses, denial of service through request size and concurrency, and prompt injection through receipt images, each listing Finding IDs or the reason no Finding applies.
4. THE Security_Review SHALL record each Finding with a unique ID, a title, a severity of Critical, High, Medium, Low, or Info, a location (file and line, or the place where a missing control belongs), the evidence, the impact, the recommendation, and a status of Fixed, Already Mitigated, Accepted Risk, Operator Action, or Deferred.
5. THE Security_Review SHALL record each gap listed under "Gaps found" in the Introduction as at least one Finding naming the gap.
6. IF a Finding has severity Critical or High, THEN THE agent SHALL give the Finding status Fixed, or Operator Action with the reason, and SHALL NOT give the Finding status Accepted Risk or Deferred.
7. THE Security_Review SHALL assign severity as follows: Critical when an anonymous visitor can read or change another user's data, obtain the OpenAI_Key or a session token, or run code on the App_Server; High when a Member or Trip_Participant can read or change another trip's data, call the Admin_API, run script in another user's browser, or cause OpenAI requests beyond the AI_Cost_Config limits; Medium when an attack needs a precondition outside the attacker's control; Low when a defense-in-depth control is missing and no attack path exists; and Info for observations with no security impact.
8. THE Security_Review SHALL give status-specific evidence for each Finding: for Fixed, the name of the verifying test; for Already Mitigated, the file and line of the control; for Accepted Risk and Deferred, the reason and the condition for revisiting; and for Operator Action, a reference to the matching Security_Report step.
9. THE Security_Review SHALL show any secret, token, or key only as a Redacted_Value.

### Requirement 25: Tests for Every Fix

**User Story:** As the operator, I want every fix covered by automated tests, so that I can trust the changes and keep them working.

#### Acceptance Criteria

1. WHEN the agent fixes a Finding, THE agent SHALL add at least one automated test to the Unit_Suite or the E2E_Suite that fails against the code before the fix and passes after the fix.
2. WHEN the agent fixes a Finding, THE Security_Report SHALL list the Finding ID, the name and file of each such test, and the test's before (fail) and after (pass) results.
3. WHEN a Finding has status Already Mitigated, THE Unit_Suite or the E2E_Suite SHALL contain at least one test that passes with the control in place and fails without the control, and THE Security_Report SHALL name the test next to the Finding ID.
4. WHEN the agent starts work on this feature, before changing any file, THE agent SHALL run the Unit_Suite and the E2E_Suite once and record every test's name and result as the baseline in the Security_Report.
5. WHEN every Finding has a status other than open, THE Unit_Suite SHALL report zero failed and zero skipped tests in a single run.
6. WHEN every Finding has a status other than open, THE E2E_Suite SHALL report zero failed tests in a single run, and THE Security_Report SHALL list each skipped E2E test with the test name and the reason.
7. THE tests that pass in the baseline SHALL pass in the final runs, unless the Security_Report lists the test, the changed expectation, and the Finding ID that caused the change.
8. THE security tests SHALL pass with no outbound network access other than loopback (127.0.0.1 or ::1).
9. THE security tests SHALL pass while `CAMPING_OPENAI_API_KEY` is unset or holds a Canary_Secret and `CAMPING_OPENAI_API_KEY_FILE` is unset or names a file holding a Canary_Secret, and no security test SHALL send a request to an OpenAI host.
10. IF a security test needs a receipt AI response, THEN THE security test SHALL use a fake receipt AI client or a loopback stub server.

### Requirement 26: Security Report

**User Story:** As the operator, I want one report of what was found, what was changed, and what I still need to do, so that I can act on the results.

#### Acceptance Criteria

1. WHEN the agent has finished the code changes and test runs for Requirements 1 to 25, THE agent SHALL write the Security_Report as Markdown at `docs/security-report.md`.
2. THE Security_Report SHALL contain these headings in this order: summary, scope and method, findings, changes made, test results, operator actions, and remaining risks.
3. THE Security_Report SHALL contain a table with exactly one row for each of the operator's 25 items, giving the item number, the covering requirement, the related Finding IDs or "none", exactly one status out of Fixed, Already in Place, Operator Action, or Not Applicable, and a one-line reason.
4. THE summary section SHALL state the number of Findings per severity and per status, equal to the counts in the Security_Review.
5. THE findings section SHALL list every Security_Review Finding by ID, title, severity, and status, so that no Finding ID appears in one document and is missing from the other.
6. THE changes section SHALL list each added, modified, or deleted file by repository-relative path with a one-line description and the related Finding or requirement IDs.
7. THE test results section SHALL list each command run, at minimum the Unit_Suite, the E2E_Suite, the Secret_Scanner, and the Dependency_Audit, with passed, failed, and skipped counts and the run date in YYYY-MM-DD format, all from runs after the last code change.
8. IF any test or check failed or was skipped, THEN THE Security_Report SHALL name the test or check with a one-line reason, and the remaining risks section SHALL hold a matching entry.
9. THE operator actions section SHALL list as separate entries each action the agent cannot perform, including at least key revocation, git history rewrite, OpenAI budget limits, nginx deployment, and TLS certificate setup, each with numbered steps, related Finding IDs, and the risk that remains until the action is done.
10. THE remaining risks section SHALL list each Finding whose status is not Fixed or Already Mitigated, with the Finding ID, severity, and a one-line reason.
11. THE Security_Report SHALL show every secret, including the OpenAI_Key, Secret_Finding values, and Canary_Secrets, only as a Redacted_Value.
12. THE README SHALL contain relative Markdown links to the Security_Report and the Security_Review, both resolving to existing files.

## Decisions and Assumptions

### Decisions

- **`publish-behind-nginx` is implemented and authoritative:** Its behavior was decided by the operator. Where this spec and that spec overlap, this spec follows the shipped behavior and only adds checks, tests, or stricter controls that leave that behavior intact. The section "Alignment with publish-behind-nginx" lists each change.
- **CSRF approach:** Keep the exact `Origin` match against the Expected_Origin, the `Sec-Fetch-Site` check, JSON-only content types, and `SameSite=Strict` Session_Cookies, with no synchronizer token. OWASP accepts this combination for same-origin JSON APIs that accept no cookie-authenticated form posts. Requirement 10.9 records the reasoning in the Security_Review, and Requirement 10.10 reopens the decision if a route starts accepting a form-style body.
- **Browser OCR removal:** Confirmed by the operator. Requirement 22.5 removes the browser OCR path unconditionally, and Requirement 9.11 removes `'wasm-unsafe-eval'` from the Content-Security-Policy.
- **Alert channel:** Security_Alerts appear on the Admin_Page and in the server log. A LINE webhook alert is a separate future feature and is out of scope here. Requirements 23.16 to 23.18 route every Security_Alert through the Alert_Dispatcher so that the LINE notifier can be registered later without changing alert detection.
- **Monthly AI limit default:** 1000 requests per UTC month, confirmed by the operator. The value stays configurable through the AI_Cost_Config.
- **Admin trip access:** Confirmed by the operator. Admins keep read and manage access to every trip (Requirement 6.8), and the Security_Report records this as intended behavior (Requirement 6.9).

### Assumptions

- **Git history:** The workspace root is not a git repository. The Secret_Scanner will scan files here and print the command for scanning history in your real repository clone.
- **OpenAI pricing:** The default model `gpt-6-luna` is kept. The Security_Report will look up the current price at review time instead of assuming a price.

### Values checked against the code

These refined values match the code and were kept: password length 12 to 128 code points (`validatePassword`); username normalization on login of trim, lowercase, first 64 characters; username format `^[a-z][a-z0-9-]{2,31}$`; session tokens of 32 random bytes encoded as 64 lowercase hex characters (`newToken`, `TOKEN`); Session_Cookie `Max-Age` of 604800 seconds (`SESSION_TTL` of 7 days); OpenAI timeout of 55 seconds (`AI_TIMEOUT_MS`); OpenAI response limit of 256 KiB; redirects refused on the OpenAI call; OpenAI key format `sk-` plus at least 20 characters from `[A-Za-z0-9_-]`; model ID format `gpt-` plus 1 to 80 characters; Admin_API routes `GET /api/admin/users`, `PATCH /api/admin/users/{id}`, `POST /api/admin/users/{id}/delete`, `POST /api/admin/trips/{id}/delete`, `GET /api/admin/audit`; fixed rate-limit windows that start at the first counted hit; receipt image limits of 3.5 MiB, 8000 px per side, and 20,000,000 px; status 415 for a type or signature mismatch; `maxRequestBodySize` of 4,194,304 bytes; account trip import limit of 1 MiB in `src/accounts-ui.js`.

Corrections made to the refined text to match the code:

- **Requirement 4.1, 4.2, and 4.10:** The code counts a login failure only after it checks that the username and password are strings. A body with a non-string username or password returns 400 and is not counted. The refined text counted every Failed_Login_Event, which would include `invalid_input` and `rate_limited` events. The criteria now say "counted login failures", and 4.10 applies to requests with a string username and password.
- **Requirement 18.1:** The model ID variable already exists as `CAMPING_OPENAI_MODEL_ID`, and the criterion names it.

New values kept as assumptions (none of these is in the code today):

- **AI limits by UTC calendar day and month (18.1, 18.3, 18.6):** The code's daily limit is a rolling 24-hour window held in memory. The spec changes it to UTC calendar periods stored in the Accounts_DB. Taiwan local midnight (UTC+8) is an alternative if you prefer.
- **AI_Cost_Config ranges (18.2):** maximum completion tokens 1 to 16000, per-user 1 to 100, daily 1 to 10000, monthly 1 to 100000, image detail `low`, `high`, or `auto`.
- **Upload read cutoff (17.3):** reading stops within 64 KiB past the limit.
- **Secret_Scanner thresholds (15.1, 15.4):** 50 MB file size cap, 20-character minimum, entropy of 3.5 bits per character, and exit code 2 for an incomplete scan.
- **Security_Alert retention and cooldown (23.4, 23.6):** at most 1000 Security_Alerts and a 15-minute cooldown for each alert type and username.
- **Escape_Function backtick (9.2):** `escape` in `src/model.js` escapes `&`, `<`, `>`, `"`, and `'` but not `` ` ``. Requirement 9.2 needs a code change.
- **CSRF check order (10.3, 10.4):** Many handlers today call `requireUser` before `readJson`. A request with no session and the wrong content type gets 401, not 415. Requirement 10.4 moves the content-type check ahead of the session check, but after the closed-registration 403 and the `register` limiter, because the shipped tests in `tests/publish.test.js` expect a body-less closed `POST /api/register` to get 403 and expect 415 registration attempts to count toward the `register` limit.
- **Public database path (20.9):** The code rejects any path segment named `dist` or `public` and does not resolve symlinks. Requirement 20.9 also asks for symlink resolution and a check against the configured Build_Output (`CAMPING_DIST`).
- **Local backup import (17.9, 17.10):** The local-handbook import in `src/app.js` allows files up to 2,000,000 bytes. Requirement 17.9 lowers this to 1 MiB. No ledger import UI exists today, so the ledger part of 17.9 applies only if one is added.
- **Expired invites (6.6):** The App_Shell also handles status 410 for invites, but the App_Server never sends 410. The spec uses the single PBN 404 for every unusable token.
- **AI_Cost_Config validation (18.2):** A separate pure parser throws the same ConfigError as `parseDeploymentConfig`, so the error output and exit code match PBN 2 without changing the `DeploymentConfig` object that existing tests compare field by field.

### Open Questions

These need an operator decision before or during implementation. The spec proceeds with the stated default.

- **AI day and month boundary (18.1, 18.3, 18.6):** Default UTC calendar day and month. Alternative: Taiwan local time (UTC+8), which resets at local midnight instead of 08:00.
- **AI_Cost_Config on the Admin_Page (18.1, 18.6):** Default environment variables only, read at startup, with the Admin_Page showing the values read-only. Alternative: store the limits in the Settings_Store and edit them on the Admin_Page like the Receipt_AI_Policy.
- **Admin access to ledgers (6.8, 6.11):** Default keep today's behavior: an Admin who is not a person in the trip gets 404 on the ledger and receipt AI routes. Alternative: give Admins read-only ledger access to every trip.
- **401 during an unsaved edit (1.10):** Default keep today's trip and ledger editor behavior: on a 401 from a save, the page stays and asks the user to export unsaved changes. Only 401s while loading a Private_Page clear the DOM and redirect. Alternative: always clear and redirect, which discards unsaved edits.
- **Login return path (1.2, 1.9):** Default widen `safeNext` to every Private_Page pattern, so a signed-out visitor returns to the page they opened. Alternative: keep `safeNext` limited to invite paths and send everyone else to their home page after login.

## Alignment with publish-behind-nginx

Each change made to this document after the `publish-behind-nginx` (PBN) implementation:

| Area | Change | PBN reference |
| --- | --- | --- |
| Introduction | "Controls already present" and "Gaps found" rewritten from the shipped code. The proxy gap is removed because it is fixed. New gaps added: `Sec-Fetch-Site`, content-type order, `OPTIONS` 404, backtick escaping, `safeNext`, missing 500 log line, DB path symlinks, 2 MB import, `.kiro` in `.dockerignore`, nginx dot-segment rule, fixed model settings. | 2–19 |
| Glossary | Public_API now lists `GET /api/invites/{token}/preview` and `POST /api/invites/{token}/register` (rate-limited) and marks `POST /api/setup` as Local_Mode only. Protected_API lists the invite list and revoke routes. Admin_API names `/api/admin/settings`. New terms: Participant_Only_Route, Invite_Page_Carve_Out, ConfigError, Receipt_AI_Decision, JSON_Route, and references to PBN terms. | 8.2, 14, 15, 18, 19, 11.8 |
| 1.2, 1.12, 1.13 | `/invite/{token}` is carved out of the signed-out redirect. A signed-out visitor sees only the Invite_Preview fields and the registration form for a Valid_Invite; the 404, 429, and no-admin cases are spelled out. Marked already in place. | 14.1, 15.1, 15.2, 15.9 |
| 1.7 | Route inventory has three classes, runs in both modes, and names the classification of the new routes and of `/api/setup`. | 8.2, 14, 15, 18, 19, 11 |
| 1.9 | `next` must match a Private_Page pattern; invite paths stay accepted. | 14.1 |
| 1.10 | Limited to 401s while loading a Private_Page; the existing unsaved-edit message on save stays (conflict with the editor's export flow, not with PBN). | — |
| 1.11 | Marked already in place. | — |
| 2.1 | Invite registration and the Create_Admin_CLI added as user-creation paths. | 8.13, 14.2 |
| 3.3–3.6, 3.8 | `Secure` rule restated to the shipped rule (Proxied_Request in Published_Mode, or `https:`), including Direct_Local_Requests in Published_Mode. Marked already in place. Invite registration added to 3.8 and 3.9. | 5.1, 5.3 |
| 4.1–4.4, 4.6, 4.7, 4.9, 4.10 | Marked already in place. 4.3 states that a closed `POST /api/register` returns 403 before the limiter and is not counted, and that rejected attempts that pass the limiter still count. 4.5 extends `Retry-After` to the `invitePreview` limit. | 7, 10.2, 14.9, 15.4 |
| 5.3, 5.4, 5.6, 5.7, 5.8 | 5.3 and 5.4 marked already in place. 5.6 covers `/api/admin/settings` and the new admin routes. 5.7 lets the CSRF checks answer first. 5.8 now follows 1.2 (redirect with `next`) instead of a separate sign-in message. | 11.8–11.10 |
| 6.1, 6.5, 6.6, 6.8, 6.9, 6.11 | Invite list and revoke added to the trip-scoped checks. Invite reads follow the Valid_Invite, single-use, and identical-404 rules. Admin access excludes Participant_Only_Routes, matching `ledgerAccess`. | 15.3, 17.3, 17.4, 18.4, 19.6 |
| 9.6, 9.10 | XSS checks cover the signed-out invite page, the Invitation_Dialog list, and the admin settings section. CSP stays valid for the Published_Mode shell meta tag. | 9.6, 14.1, 19.10, 11.11 |
| 10.1, 10.3, 10.4, 10.7, 10.8 | 10.1 and 10.8 marked already in place. Content-type check order keeps the closed-registration 403, the `register` limiter, and the setup loopback 403 first. Tests run in both modes. | 4, 8.5, 10.2, 14.9 |
| 11.1, 11.6 | Header coverage includes the Published_Mode shell, rewritten `sw.js`, host and forwarding errors, and Published_Mode 404s, and keeps the shipped `Cache-Control` values. HSTS marked already in place. | 3.1, 5.4, 6.4, 9.6, 15.6 |
| 12.2, 12.6, 12.7 | Marked already in place where the code or the nginx example already complies; the preview route is added to the tests. | 12 |
| 13.1, 13.7 | Marked already in place; 13.7 uses the PBN `disabledReason` values. | 11.4 |
| 17.1–17.8, 17.11, 17.12 | Marked already in place; 17.12 keeps the policy check before image reading. | 11.2, 11.3, 12.5 |
| 18.1–18.4, 18.6, 18.9, 18.12–18.14 | AI_Cost_Config is validated by the Startup_Validator through ConfigError. Limits count only allowed requests, after the Receipt_AI_Decision. The usage view sits next to the Receipt_AI_Policy control. The `authorize()` re-checks stay. 18.7 and 18.8 marked already in place. | 2, 11 |
| 19.3, 19.5, 19.6 | Log line also required for errors caught inside `accounts.handle`. 19.5 and 19.6 marked already in place, with the Published_Mode route removals named. | 8.1, 8.2, 9.1 |
| 20.1–20.3, 20.5–20.9 | 20.1–20.3, 20.6, and 20.7 marked already in place. 20.5 names `.kiro` as the only missing entry. 20.8 keeps the PBN nginx blocks. 20.9 names `CAMPING_DIST` and the existing `dist`/`public` rule. | 12 |
| 22.5 | OCR removal keeps the `const PUBLISHED=false;` literal and the `/demo` guard in `sw.js`. | 9.3, 9.6 |
| 23.1 | Failed_Login_Events are written only for requests that reach the login handler and use the PBN Client_Address. | 6, 7 |
| 24.3 | Review sections added for the invite flows, the Create_Admin_CLI, and the deployment configuration. | 2, 8, 14–19 |
