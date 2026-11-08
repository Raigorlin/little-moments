# Implementation Plan: Security Hardening

## Overview

Implementation is in JavaScript (ES modules on Bun, `bun test` for unit and property tests with fast-check, Playwright through `scripts/check-accounts.mjs` for e2e). The work starts by recording the test baseline and adding the pure helper modules with their property tests. It then removes the browser OCR path, hardens the request pipeline (headers, CSRF gate, `OPTIONS`, `Retry-After`, safe logging, database path guard), moves receipt AI limits into the Accounts_DB with usage records, adds failed-login events and alerts, updates the client, fixes configuration and documents, adds the Secret_Scanner, and ends with the Dependency_Audit, the Security_Review, and the Security_Report. Every task changes code, tests, configuration, or repository documentation only. Nothing is deployed, no key is revoked, and no git history is rewritten.

The `publish-behind-nginx` (PBN) behavior is authoritative. Criteria marked "Already in place" in the requirements get tests here, not new implementation.

Checkpoint commands (PowerShell does not expand `tests/*.test.js`, so pass the directory):

- Unit and property tests: `Remove-Item Env:CAMPING_DIST -ErrorAction SilentlyContinue; bun run build; bun test tests` (the static and build tests read `dist/`, so `CAMPING_DIST` must be unset)
- E2E: `bun run build`, then `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs <files>` (set `CHROME_PATH` if Chrome is not at the default path). All files passed in one run share one server and one `register` limit of 20 attempts per hour for `127.0.0.1`, so run the security e2e files in a separate invocation from the PBN e2e files.

## Tasks

- [x] 1. Record the baseline and add the pure helper modules
  - [x] 1.1 Record the baseline in `docs/security-report.md`
    - Before any other change, run `bun test tests` and the e2e files with `node scripts/check-accounts.mjs`, and write each test name and result, the command, and the date under a `Baseline` heading
    - Create the file with the Requirement 26.2 headings as empty sections to be filled in task 13.3
    - _Requirements: 25.4_

  - [x] 1.2 Create `server/safe-log.js`
    - Export `GENERIC_500`, `formatErrorLine({ at, method, path, error })`, and `logRequestError({ method, url, error, at, sink })` per the design
    - The line holds only the ISO time, method, query-free path, and a sanitized error name
    - _Requirements: 19.1, 19.3_

  - [x] 1.3 Create `src/auth-paths.js`
    - Export `PRIVATE_PATH_RE`, `safeNext`, and `loginPath` per the design; no DOM access and no import side effects
    - _Requirements: 1.2, 1.9_

  - [x] 1.4 Create `server/ai-cost.js`
    - Export `AI_ENV`, `AI_COST_DEFAULTS`, `parseAiCostConfig` (throws the PBN `ConfigError` naming the variable and range), the UTC boundary helpers, `quotaDecision`, and `costEstimate`
    - Do not change `parseDeploymentConfig` or the `DeploymentConfig` shape
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.10_

  - [x] 1.5 Create the pure part of `server/security-events.js`
    - Export `EVENT_REASONS`, `ALERT_RULES`, `eventUsername`, `evaluateAlerts`, `formatAlertLine`, and `createAlertDispatcher({ store, log, notifiers })` with notifier delivery through `queueMicrotask` and per-notifier error isolation
    - _Requirements: 23.2, 23.6, 23.7, 23.16, 23.17_

  - [x] 1.6 Escape the backtick in `src/model.js`
    - `escape` maps `` ` `` to `&#96;`; add one backtick example to `tests/model.test.js`
    - _Requirements: 9.2, 9.3, 9.4_

  - [x] 1.7 Write property tests in `tests/security-client.test.js`
    - **Property 2: Login return paths are limited to Private_Page patterns**
    - **Property 13: Escaping round trip** (`numRuns: 1000`)
    - **Property 14: Map links never carry user-chosen schemes**
    - One `fc.assert` per property, tagged `// Feature: security-hardening, Property N: …`
    - **Validates: Requirements 1.2, 1.9, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8**

  - [x] 1.8 Write tests in `tests/ai-cost.test.js`
    - **Property 22: Invalid AI settings stop startup with a named error**
    - Examples: defaults for an empty environment, UTC day and month boundaries (including 31-day and February months), `quotaDecision` waits for each exceeded limit, `costEstimate` arithmetic
    - **Validates: Requirements 18.1, 18.2, 18.4**

  - [x] 1.9 Write pure tests in `tests/security-events.test.js`
    - **Property 29: Alerts follow thresholds and cooldowns** (reference model over generated timelines)
    - **Property 30: Notifiers cannot affect alert storage or each other** (fake store; notifiers that return, throw, reject, or never settle)
    - Examples: `eventUsername` for valid, uppercase, padded, out-of-format, and non-string input; `formatAlertLine` content
    - **Validates: Requirements 23.2, 23.6, 23.7, 23.16, 23.17**

- [x] 2. Remove the browser OCR path
  - [x] 2.1 Move the image helpers to `src/receipt-image.js`
    - Copy `sniffImageType`, `readImageSize`, `validateReceiptBytes`, `MAX_RECEIPT_BYTES`, and `MAX_RECEIPT_PIXELS` unchanged; update the imports in `server/receipt-ai.js` and `src/receipt-ai-client.js`; delete `src/receipt-ocr.js`
    - _Requirements: 22.4, 22.5_

  - [x] 2.2 Remove the OCR copy step from `scripts/build.mjs`
    - Remove the `pinned` check, the OCR copy list, `NOTICE.txt`, and the OCR size log
    - Keep the generated `sw.js` first line `const PUBLISHED=false;`, the `-p` cache suffix, and the `/demo` navigation guard exactly as PBN shipped them
    - _Requirements: 22.5_

  - [x] 2.3 Remove the OCR packages
    - `bun remove tesseract.js @tesseract.js-data/chi_tra @tesseract.js-data/eng`, which updates `package.json` and regenerates `bun.lock`; confirm that `tesseract.js-core` no longer appears in `bun.lock`
    - _Requirements: 22.2, 22.5_

  - [x] 2.4 Update the OCR tests
    - Create `tests/receipt-image.test.js` with the image helper cases from `tests/receipt-parser.test.js`, and remove the OCR-only cases (`planOcrSize`, `recognizeReceipt`) from `tests/receipt-parser.test.js`
    - Add **Property 21: Receipt image validation accepts exactly complete images** to `tests/receipt-image.test.js` against `validateAiImage`
    - Rewrite `tests/ocr-assets.e2e.js` to assert that `/assets/ocr/worker.min.js` returns 404 and that the CSP contains no `'wasm-unsafe-eval'` (passes after task 4.1)
    - **Validates: Requirements 17.1, 17.2, 17.4, 17.5, 22.5**

  - [x] 2.5 Remove obsolete references
    - Remove the Tesseract licensing sentence from `README.md`
    - Remove `CAMPING_BEDROCK_REGION`, `CAMPING_BEDROCK_MODEL_ID`, and `CAMPING_BEDROCK_API_KEY` from the server environment in `scripts/check-accounts.mjs`
    - _Requirements: 22.5, 22.6_

- [x] 3. Checkpoint - Ensure all tests pass
  - Run `bun run build` and `bun test tests` with `CAMPING_DIST` unset. Ensure all tests pass, ask the user if questions arise.

- [x] 4. Harden the request pipeline
  - [x] 4.1 Update `server/http.js`
    - New `SECURITY_HEADERS` per the design: CSP without `'wasm-unsafe-eval'`, with `object-src 'none'` and `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `Cross-Origin-Opener-Policy: same-origin`; `Cross-Origin-Resource-Policy: same-origin`
    - Keep `shellResponse`, `swResponse`, the PBN host and forwarding error responses, and the existing `Cache-Control` values (`no-store` shell and `/invite/{token}`, `no-cache` for `sw.js` and assets)
    - The `catch` block uses `logRequestError`
    - _Requirements: 9.10, 9.11, 11.1, 11.2, 11.3, 11.4, 11.5, 13.8, 19.1, 19.3_

  - [x] 4.2 Add the CSRF gate, `OPTIONS` 405, `Retry-After`, and safe errors to `server/accounts.js`
    - `handle`: `OPTIONS` → 405 before the route loop; `Sec-Fetch-Site: cross-site` → 403 `不接受跨站請求。` after the PBN Origin check; the `catch` for unknown errors calls `logRequestError` and returns `GENERIC_500`
    - `HttpError` takes optional headers and `errorResponse` sends them
    - `RateLimiter.retryAfter(key)` and `RateLimiter.noteOnce(key)`; the `limited(keys, message)` helper replaces `fail(429, …)` in `login`, `register`, `inviteRegister`, and `invitePreview` with unchanged messages
    - `requireJsonType(request)` at the start of every JSON_Route handler in the order of the design table, keeping the closed-registration 403, the `register` limiter, and the setup loopback 403 first
    - Export `hashPassword` and `verifyPassword`; `verifyPassword` returns `false` instead of throwing for impossible scrypt parameters
    - _Requirements: 2.6, 4.5, 10.2, 10.3, 10.4, 10.5, 12.3, 12.4, 19.1, 19.2, 19.3_

  - [x] 4.3 Add the database path guard
    - In `server/accounts.js`: `isPublicDbPath(full, real, publicRoots)`, `PublicDbPathError`, and `assertPrivateDbPath(dbPath, { publicRoots })` resolving the nearest existing ancestor with `realpath`; the check runs before `new Database(...)`; new factory option `publicRoots = []`
    - In `scripts/serve.mjs`: pass `publicRoots: [resolve(project, process.env.CAMPING_DIST || 'dist')]`, print the error, and exit 1 before `Bun.serve`
    - _Requirements: 20.9_

  - [x] 4.4 Write `tests/security-headers.test.js`
    - **Property 17: Every response carries the security headers exactly once** (Local_Mode and Published_Mode handlers over the same `dist`)
    - Examples: CSP directives parsed and compared, Permissions-Policy, each response kind of Requirement 11.1, no `Access-Control-*` across modes and route classes including the Invite_Preview
    - **Validates: Requirements 9.10, 9.11, 11.1, 11.2, 11.3, 11.4, 11.5, 11.8, 12.2, 12.7, 13.8**

  - [x] 4.5 Write `tests/security-csrf.test.js`
    - **Property 15: The CSRF gate follows its decision table** (both modes; accounts created once in `beforeAll`)
    - **Property 18: OPTIONS on the API is always 405 and inert**
    - Examples: the per-route matrix of Requirement 10.7; PBN orderings (Published_Mode body-less `POST /api/register` → 403; 415 registration attempts count toward `register`; setup loopback 403 before 415); `OPTIONS` with a foreign `Origin` and `Access-Control-Request-Method: POST`
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 12.3, 12.4, 12.5, 12.8**

  - [x] 4.6 Write `tests/security-auth.test.js`
    - **Property 1: Every unusable session is rejected on every protected route**
    - **Property 3: Password length rule is exact**
    - **Property 4: Password hashing round trip with unique salts**
    - **Property 5: Malformed stored hashes fail closed**
    - **Property 6: Retry-After matches the remaining window**
    - **Property 7: Admin routes refuse Members and signed-out callers without side effects**
    - Examples per the design: route inventory in both modes with the Requirement 1.7 classes and a drift check; cookie attributes and expiry; logout with and without a session; session replacement on login, register, invite registration, and setup; raw token absent from the DB file and audit; demotion on the next admin request; admin route matrix; dummy hash for unknown users; Canary_Secret password absent from the DB file, WAL, audit, logs, and responses; hash format for each creation path including the Create_Admin_CLI with an injected prompt; `Retry-After` on each limiter's 429; blocked login runs no hash
    - **Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 2.10, 3.1, 3.2, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.2, 4.5, 4.6, 4.9, 4.10, 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.9, 19.6**

  - [x] 4.7 Write `tests/security-files.test.js`
    - **Property 25: Uncaught errors reveal nothing** (stub account service and a throwing route)
    - **Property 26: Traversal never escapes the Build_Output**
    - **Property 27: The database path guard rejects public locations**
    - Examples: sensitive paths and case variants; equal status for an existing and a missing non-allowlisted file; fresh build into a temporary `CAMPING_DIST` with no `.map`, no `sourceMappingURL`, none of the forbidden files, no `assets/ocr/`, `sw.js` starting with `const PUBLISHED=false;`, and no Canary_Secret from the environment; startup refusal for a Build_Output path, a `public` path, and a symlink into the Build_Output (skip the symlink case with a logged reason when the OS refuses to create it); the static SQL check over `server/` with its two fixtures; OpenAI key canary absent from every route response and from logs; key file rotation on a new `createReceiptAi`; `api.openai.com` and `CAMPING_OPENAI_API_KEY` absent from `src/` and the Build_Output
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 13.1, 13.2, 13.3, 13.6, 13.9, 14.3, 14.4, 16.7, 19.1, 19.3, 19.4, 19.7, 19.8, 19.9, 20.1, 20.2, 20.3, 20.4, 20.9, 20.10**

  - [x] 4.8 Write `tests/security-access.test.js`
    - **Property 8: Members outside a trip cannot tell the trip exists**
    - **Property 9: Trip lists match membership**
    - **Property 10: User text is stored and returned unchanged**
    - **Property 11: Mutating routes never fail with 5xx and reject atomically**
    - **Property 12: Stored trip state keeps only schema fields**
    - **Property 16: GET and HEAD never change the database**
    - Examples: SQL payloads in login, invite tokens, and trip IDs; Admin access on non-participant-only routes and 404 on Participant_Only_Routes; ledger GET and PUT by an outsider; boundary cases per mutating route
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.8, 6.10, 6.11, 7.6, 7.7, 7.8, 7.9, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 10.6**

- [x] 5. Checkpoint - Ensure all tests pass
  - Run `bun run build` and `bun test tests` with `CAMPING_DIST` unset. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Move receipt AI limits into the Accounts_DB
  - [x] 6.1 Update `server/receipt-ai.js`
    - `createReceiptAi({ env, fetchImpl, timeoutMs, cost })` sends `cost.modelId`, `cost.imageDetail`, and `cost.maxCompletionTokens` when `cost` is given and keeps today's values otherwise; the key and model checks stay
    - `recognize(bytes, type, { signal, onUsage })` reports integer token counts (0 when absent) right after parsing the envelope
    - _Requirements: 18.5, 18.7, 18.14_

  - [x] 6.2 Add usage records and the persistent quota to `server/accounts.js`
    - `receipt_ai_usage` table and indexes in `SCHEMA`; factory option `aiCost = AI_COST_DEFAULTS`
    - `reserveAiCall` (count, `quotaDecision`, insert `pending`, trim rows older than 400 days, all in `tx`) and `settle`; 429 with `Retry-After`; 503 when the table cannot be read or written
    - Replace the `ai:<user>` and `ai:global` limiter calls; keep the `aiActive` concurrency map, the PBN `authorize()` and `checkPolicy` order, and the post-call re-check
    - `GET /api/admin/receipt-ai-usage` with `requireAdmin`
    - _Requirements: 17.12, 18.3, 18.4, 18.5, 18.6, 18.8, 18.9, 18.12, 18.13_

  - [x] 6.3 Validate AI_Cost_Config at startup in `scripts/serve.mjs`
    - Call `parseAiCostConfig(process.env)` in the same `try` as `parseDeploymentConfig`, with the same `Configuration error:` output and exit 1
    - Pass `cost` to `createReceiptAi` and `aiCost` to `createAccountService`; keep the PBN startup log lines
    - _Requirements: 18.1, 18.2_

  - [x] 6.4 Write `tests/receipt-ai-cost.test.js`
    - **Property 23: Receipt AI calls follow the persistent quota model** (fake provider, injected clock, file-backed database in a temporary directory)
    - **Property 24: Each OpenAI call leaves exactly one usage record**
    - Examples: counts survive closing and reopening the database; 503 when the usage table is dropped; policy `off` and `admins` refuse before the quota; a policy change during the call keeps the row; configured model, detail, and token cap in the request body through a fake `fetchImpl`; admin usage totals for day and month; one provider call per request
    - **Validates: Requirements 18.3, 18.4, 18.5, 18.6, 18.7, 18.9, 18.12, 18.13, 18.14**

- [x] 7. Record failed logins and raise alerts
  - [x] 7.1 Add the database part of `server/security-events.js`
    - `createSecurityEventStore(db, clock, { maxEvents, maxAlerts })` with insert, window reads, `lastAlertAt`, list, acknowledge, and trimming (acknowledged alerts removed before unacknowledged ones); `recordFailedLogin` inserts, evaluates, dispatches, and trims in one transaction
    - _Requirements: 23.4, 23.6, 23.10, 23.16_

  - [x] 7.2 Wire events and admin routes into `server/accounts.js`
    - `security_events` and `security_alerts` tables in `SCHEMA`; the service creates the store and dispatcher and exposes `registerAlertNotifier`
    - Restructure `routes.login` so every exit records one reason (`invalid_input`, `rate_limited` once per blocked key per window through `noteOnce`, `deleted_account`, `bad_credentials`); writes are guarded and never change the response; no password reaches the store
    - `GET /api/admin/security` and `POST /api/admin/security/alerts/{id}/acknowledge` (JSON_Route, audit `security.alert.ack`)
    - _Requirements: 23.1, 23.2, 23.3, 23.5, 23.8, 23.11, 23.12, 23.13, 23.14, 23.15, 23.16_

  - [x] 7.3 Add service tests to `tests/security-events.test.js`
    - **Property 28: Each failed login is classified once without secrets** (pool of pre-registered users; at most six logins per run)
    - Examples: retention with lowered caps; `GET /api/admin/security` shape and order; acknowledge success with audit, unknown and repeated IDs; event write failure keeps the login response; the throwing, never-resolving, and recording notifier case
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5, 23.8, 23.10, 23.11, 23.14, 23.15, 23.18**

- [x] 8. Checkpoint - Ensure all tests pass
  - Run `bun run build` and `bun test tests` with `CAMPING_DIST` unset. Ensure all tests pass, ask the user if questions arise.

- [x] 9. Update the client
  - [x] 9.1 Update sign-in redirects in `src/accounts-ui.js`
    - Import `safeNext` and `loginPath` from `src/auth-paths.js` and re-export `safeNext`
    - Signed-out home, trip, and admin use `go(loginPath(location.pathname))`; the invite branch keeps PBN behavior
    - Add `expireToLogin()` and use it for 401s while loading the home trip list, the trip envelope, the signed-in invite read, and the admin lists; leave the editor save messages in `src/app.js` and `src/expenses-ui.js` unchanged
    - _Requirements: 1.2, 1.9, 1.10, 1.12, 1.13, 5.8_

  - [x] 9.2 Add the usage and login security sections to the Admin_Page in `src/accounts-ui.js`
    - `ENDPOINTS.adminReceiptAiUsage` and `ENDPOINTS.adminSecurity` in the existing `Promise.allSettled`
    - `收據 AI 用量` below `網站設定`, read-only; `登入安全` with the banner only when `unacknowledged > 0`, the alert list with `確認`, and the 200 most recent failed logins; acknowledge removes the row and lowers or hides the banner without a reload; all values through `e()`
    - _Requirements: 18.6, 23.8, 23.9, 23.10, 23.11_

  - [x] 9.3 Lower the local import limit in `src/app.js`
    - Check `file.size > 1_048_576` before `file.text()` and show `請選擇不超過 1 MiB 的備份檔。`
    - _Requirements: 17.9, 17.10_

  - [x] 9.4 Create `tests/security-pages.e2e.js`
    - Signed-out home, trip, and admin redirect to `/login?next=…` and return after login; a Member at `/admin` sees the permission message; another user's home shows the permission message without a trip list request; a 401 injected with `page.route` while loading the home list clears it and redirects; the Admin_Page usage section and, after five failed logins for one username, the alert banner that `確認` lowers and hides; the local import refuses a 1 MiB + 1 byte file
    - At most three registered accounts in this file
    - _Requirements: 1.2, 1.10, 5.5, 5.8, 6.7, 17.10, 18.6, 23.8, 23.9, 23.10_

  - [x] 9.5 Create `tests/security-xss.e2e.js`
    - Store each XSS_Payload_Set string in User_Content through the API (trip fields, participant names, display names, ledger titles and notes), then load the home page, trip page, signed-in and signed-out invite pages, Invitation_Dialog, expenses view, and Admin_Page
    - Fail on any dialog, `pageerror`, `securitypolicyviolation`, a set `window` sentinel, or an unexpected `script`, `img`, `svg`, or `iframe` element; check that each payload appears as text
    - At most three registered accounts in this file
    - _Requirements: 1.12, 9.1, 9.6, 11.9_

- [x] 10. Fix configuration files and the deployment guide
  - [x] 10.1 Add `.kiro` to `.dockerignore`
    - _Requirements: 20.5_

  - [x] 10.2 Update `docs/deploy-nginx.md`
    - Add `location ~ /\.(?!well-known/) { return 404; }` inside the `www` server block before `location /`, with a one-line comment; leave every other PBN line unchanged
    - Add the AI_Cost_Config variables with defaults to the settings table
    - _Requirements: 18.1, 20.8_

  - [x] 10.3 Update `README.md`
    - Recommend `CAMPING_OPENAI_API_KEY_FILE` over `CAMPING_OPENAI_API_KEY`; explain that environment values show in `docker inspect` and process listings and that `ARG` values show in image history; list the AI_Cost_Config variables
    - _Requirements: 14.8, 18.1_

  - [x] 10.4 Write `tests/security-config.test.js`
    - Document checks of `docs/deploy-nginx.md`: HSTS `max-age=15552000`, `client_max_body_size` ≤ 4m, no `Access-Control-*` `add_header`, no `OPTIONS` handling, the dot-segment `location` before `location /`
    - Source checks: `maxRequestBodySize` ≤ 4,194,304; no `--inspect`, `--hot`, or `--watch` in the `start` script and Dockerfile `CMD`; `.dockerignore` and `.gitignore` entries; Dockerfile runtime `COPY` lines; compose uses the secret file and no `CAMPING_OPENAI_API_KEY`; `.env.example` placeholders when the file exists; no Secret_Scanner rule match in `Dockerfile`, `docker-compose.yml`, or `.env.example`, printed only as Redacted_Values; no `CAMPING_BEDROCK` outside `.kiro/`, `node_modules/`, and the Build_Output
    - _Requirements: 11.6, 12.6, 14.5, 14.6, 14.7, 14.9, 14.10, 17.7, 17.11, 19.5, 20.5, 20.6, 20.7, 20.8, 22.6_

- [x] 11. Add the Secret_Scanner
  - [x] 11.1 Create `scripts/secret-rules.mjs`
    - `RULES`, `shannonEntropy`, `redact`, `scanText`, and `parseAllowlist` per the design
    - _Requirements: 15.4, 15.5, 15.7, 15.12_

  - [x] 11.2 Create `scripts/scan-secrets.mjs` and `scripts/secret-allowlist.json`
    - Walk every file outside `node_modules/`, including ignored files and binaries, skipping files over 50 MB with a notice; scan `git log --all -p` when inside a git work tree, else print the history notice and the command for the real clone
    - Exit 0 clean with counts, 1 on findings outside the allowlist, 2 on an incomplete scan or invalid allowlist; print only Redacted_Values
    - The allowlist lists the test Canary_Secret patterns, each with a reason
    - _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7, 15.10, 15.11, 15.12_

  - [x] 11.3 Write `tests/secret-scan.test.js`
    - **Property 19: Planted secrets are found at their line**
    - **Property 20: Redaction never reveals a secret**
    - Examples in temporary directories: planted key with file, line, rule, exit 1, no full key in output; clean directory exit 0 with counts; allowlisted value exit 0; entry without a reason exit 2; unreadable file exit 2; git fixture with a key added then deleted when `git` is on PATH (otherwise skipped with a logged reason); non-repository notice; 50 MB skip notice with a sparse file
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.10, 15.11, 15.12**

- [x] 12. Checkpoint - Ensure all tests pass
  - Run `bun run build` and `bun test tests` with `CAMPING_DIST` unset. Then run the PBN and existing e2e files in one invocation, for example `node scripts/check-accounts.mjs tests/accounts.e2e.js tests/invite-registration.e2e.js tests/invite-links.e2e.js tests/trip-deletion.e2e.js tests/vehicle-departures.e2e.js tests/brand.e2e.js tests/ocr-assets.e2e.js tests/receipt-ocr.e2e.js`, and the security e2e files in a separate invocation, `node scripts/check-accounts.mjs tests/security-pages.e2e.js tests/security-xss.e2e.js`, so that the shared `register` limit is not exceeded. Ensure all tests pass, ask the user if questions arise.

- [x] 13. Audit dependencies and write the review and report
  - [x] 13.1 Run the Dependency_Audit
    - Run `bun audit` (record the database, time, package count, and every advisory; record the audit as incomplete if it fails); apply same-major fixes and update `bun.lock`; classify every package in `dependencies` and `devDependencies` with evidence; move test-only packages to `devDependencies`
    - Compare the Bun version in each `Dockerfile` `FROM` line with the latest patch of the same major.minor and update both lines if newer
    - After any update, rerun `bun run build`, `bun test tests`, and the e2e invocations of task 12, and revert an update that cannot be fixed
    - Record everything in a `Dependency_Audit` section of `docs/security-review.md`
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10, 21.11, 22.1, 22.3, 22.4, 22.7, 22.8_

  - [x] 13.2 Write `docs/security-review.md`
    - Method, threat model, OWASP Top 10 (2021) sections, and the sections of Requirement 24.3 (invite flows, setup and the Create_Admin_CLI, deployment configuration, service worker cache, request size and concurrency, prompt injection)
    - Every Finding with ID, title, severity by the Requirement 24.7 rules, location, evidence, impact, recommendation, and status; one Finding per gap in the requirements Introduction; criteria marked "Already in place" recorded as Already Mitigated with the file, line, and test name
    - The form and field table, the HTML_Sink inventory, the environment variable table, the CSRF_Decision, the read-only password hash inspection with before and after checksums, and Admin trip access as intended behavior
    - _Requirements: 2.8, 6.9, 8.7, 9.9, 10.9, 10.10, 14.1, 14.2, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9_

  - [x] 13.3 Complete `docs/security-report.md` and link both documents
    - Run `bun scripts/scan-secrets.mjs` and record the result, whether `.secrets/openai_api_key` exists and is ignored, and that git history was not scanned here with the command for the real clone
    - Fill every Requirement 26 section: the 25-item table, Finding counts equal to the review, changed files, final test results with dates, operator actions (key revocation, history rewrite, OpenAI budget, nginx deployment, TLS certificates), remaining risks, the receipt AI cost estimate with prices looked up on the OpenAI pricing page and the date checked, `'unsafe-inline'` in `style-src`, and in-memory login and registration limits
    - Add relative links to both documents in `README.md`
    - _Requirements: 4.8, 11.7, 15.9, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.8, 18.10, 18.11, 25.1, 25.2, 25.3, 25.5, 25.6, 25.7, 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11, 26.12_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Run `bun run build`, `bun test tests` with `CAMPING_DIST` unset, `bun scripts/scan-secrets.mjs`, and the two e2e invocations of task 12 with `CAMPING_BUN` set. Ensure all tests pass, ask the user if questions arise.

## Notes

- No task is marked optional, matching the other specs in this repository. Property tests are required because Requirement 25 calls for a test for every fix and every Already Mitigated Finding.
- Tasks 4.2, 4.3, 6.2, and 7.2 all write `server/accounts.js`, so they run in separate waves. Tasks 9.1 and 9.2 write `src/accounts-ui.js`; tasks 4.3 and 6.3 write `scripts/serve.mjs`; tasks 2.1 and 6.1 write `server/receipt-ai.js`; tasks 1.5 and 7.1 write `server/security-events.js`; tasks 1.9 and 7.3 write `tests/security-events.test.js`; tasks 2.5, 10.3, and 13.3 write `README.md`; tasks 13.1 and 13.2 write `docs/security-review.md`; tasks 1.1 and 13.3 write `docs/security-report.md`; tasks 2.3 and 13.1 write `package.json`. Each group runs in separate waves.
- `tests/deploy-config.test.js` compares the `DeploymentConfig` object field by field, so AI_Cost_Config has its own parser and the PBN config object does not change.
- The content-type check runs inside each JSON_Route handler rather than in the route table, because the PBN tests expect the closed-registration 403 and the `register` limiter to answer first.
- Receipt AI concurrency stays in memory; the per-user, daily, and monthly counts move to the Accounts_DB. Login and registration limits stay in memory, and the Security_Report says so.
- `scripts/check-accounts.mjs` runs in Local_Mode with an in-memory database, so the e2e files cover Local_Mode pages; Published_Mode behavior is covered by the unit tests.
- Open questions in the requirements (UTC versus Taiwan day boundary, AI limits in environment variables versus the Settings_Store, Admin ledger access, 401 during unsaved edits, `next` scope) proceed with the stated defaults. A different answer changes tasks 1.4, 6.2, 9.1, or 9.2 only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "2.1", "2.2", "10.1", "11.1"] },
    { "id": 1, "tasks": ["1.7", "1.8", "1.9", "2.3", "2.4", "2.5", "4.1", "4.2", "11.2"] },
    { "id": 2, "tasks": ["4.3", "4.4", "4.5", "4.6", "4.8", "6.1", "7.1", "10.2", "11.3"] },
    { "id": 3, "tasks": ["4.7", "6.2", "9.1", "9.3", "10.3"] },
    { "id": 4, "tasks": ["6.3", "6.4", "7.2"] },
    { "id": 5, "tasks": ["7.3", "9.2", "10.4"] },
    { "id": 6, "tasks": ["9.4", "9.5", "13.1"] },
    { "id": 7, "tasks": ["13.2"] },
    { "id": 8, "tasks": ["13.3"] }
  ]
}
```
