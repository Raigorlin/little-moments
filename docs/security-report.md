 Security Report

> **Merge note.** This report describes the `security-harden` branch before it was merged into main. Its SQLite database, nginx/published-mode and docker-compose deployment, and Bedrock-era content are superseded by the PostgreSQL data layer, the Jenkins/Deploy_Host deployment, and the OpenAI receipt AI described in the [README](../README.md). Tests named here for the removed SQLite database path guard (SR-12) no longer exist, and some test names changed in the merge.

This report is the final deliverable of the `security-hardening` spec (Requirement 26). The full evidence for every Finding is in [security-review.md](security-review.md). The baseline under "Test results" was recorded by task 1.1 before any other file in the repository was changed (Requirement 25.4). Report written 2026-11-09.

Every secret in this report is shown only as a Redacted_Value. No real secret was found, so none appears.

## Summary

The review found 61 Findings (SR-01 to SR-61). The counts below equal the counts in the Security_Review "Summary of Findings".

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 17 |
| Info | 39 |
| **Total** | **61** |

| Status | Count |
| --- | --- |
| Fixed | 19 |
| Already Mitigated | 23 |
| Accepted Risk | 11 |
| Operator Action | 2 |
| Deferred | 6 |
| **Total** | **61** |

The only High Finding, SR-02 (receipt AI limits that reset on restart and allowed about 3000 OpenAI calls a month), is Fixed. Of the four Medium Findings, SR-12 is Fixed, SR-18 (git history not scanned) is an Operator Action, SR-44 (the Rate_Limiter can forget a username lockout) is Deferred, and SR-45 (Docker local-only setup trusts a loopback Host header) is Accepted Risk.

Before publishing at `https://www.our-littlemoments.com`, do the following:

1. Fix SR-44. A distributed attacker can currently clear a username lockout and keep guessing passwords.
2. Run the Secret_Scanner in the real repository clone (SR-18).
3. Set an OpenAI project budget.
4. Deploy nginx with TLS as described in [Operator actions](#operator-actions).

### The operator's 25 items

| # | Item | Requirement | Findings | Status | Reason |
| --- | --- | --- | --- | --- | --- |
| 1 | Login required for private pages and APIs | 1 | SR-10, SR-23, SR-41, SR-57 | Fixed | Private pages now redirect to `/login?next=…` and a 401 while loading clears the page; API checks were already in place. |
| 2 | Password hashing | 2 | SR-20, SR-21 | Fixed | scrypt was already in place; a corrupt stored hash now fails closed instead of giving a 500. |
| 3 | Session cookie attributes | 3 | SR-22 | Already in Place | `HttpOnly`, `SameSite=Strict`, `Path=/`, 7-day `Max-Age`, and `Secure` behind the proxy were already set; tests added. |
| 4 | Login and registration rate limits | 4 | SR-05, SR-24, SR-44, SR-50 | Fixed | Every limiter 429 now sends `Retry-After`; SR-44 eviction weakness is Deferred. |
| 5 | Admin routes for admins only | 5 | SR-25 | Already in Place | The role is read from the database on every admin request; tests added for every admin route. |
| 6 | Users see only their own data | 6 | SR-26, SR-59 | Already in Place | Outsiders get the same 404 as a missing trip; tests added. |
| 7 | Parameterized SQL | 7 | SR-27 | Already in Place | All SQL uses `?` placeholders; a static check now enforces it. |
| 8 | Server-side validation | 8 | SR-28, SR-52, SR-53 | Already in Place | JSON-only, 1 MiB, typed field checks, and unknown-field removal already existed; property tests added. |
| 9 | XSS output escaping | 9 | SR-09, SR-40, SR-49 | Fixed | The Escape_Function now escapes the backtick; XSS e2e tests pass on every page. |
| 10 | CSRF protection | 10 | SR-06, SR-07, SR-29, SR-51 | Fixed | Added the `Sec-Fetch-Site` check and moved the content-type check ahead of the session check. |
| 11 | Security headers | 11 | SR-04, SR-49 | Fixed | CSP tightened (`frame-ancestors 'none'`, `object-src 'none'`, no `'wasm-unsafe-eval'`); `X-Frame-Options: DENY`, COOP, and CORP added. |
| 12 | CORS limited to the site's origin | 12 | SR-08, SR-30 | Fixed | No `Access-Control-*` headers; `OPTIONS` on `/api/` now always returns 405. |
| 13 | API keys kept off the frontend | 13 | SR-31 | Already in Place | The OpenAI key is read and used only on the server; canary tests added. |
| 14 | No secrets in public environment variables | 14 | SR-39, SR-58 | Already in Place | Nothing is inlined into the build; compose passes the key as a secret file. |
| 15 | Secret scanning of files and git history | 15 | SR-18 | Operator Action | `scripts/scan-secrets.mjs` added; files are clean; history must be scanned in the real clone. |
| 16 | Removal and rotation of leaked keys | 16 | SR-18, SR-61 | Operator Action | No leaked key in the scanned files; rotation depends on the history scan. |
| 17 | Upload type and size limits | 17 | SR-13, SR-32 | Fixed | Receipt limits were already in place; the local import limit was lowered to 1 MiB. |
| 18 | OpenAI cost controls | 18 | SR-02, SR-03 | Fixed | Persistent per-user, UTC day, and UTC month limits with usage records; validated cost settings. |
| 19 | Debug output off in production | 19 | SR-11, SR-34, SR-46 | Fixed | Uncaught errors give a generic body and one safe log line; SR-46 (token in the log path) is Deferred. |
| 20 | Sensitive files not reachable | 20 | SR-12, SR-14, SR-15, SR-33, SR-55 | Fixed | DB path guard resolves symlinks; `.kiro` excluded from Docker; nginx dot-path rule added. |
| 21 | Dependencies with known vulnerabilities, and unused packages | 21, 22 | SR-16, SR-54 | Fixed | `bun audit` found 0 advisories; the unused Tesseract OCR packages were removed. |
| 22 | Failed-login logging and admin alerts | 23 | SR-01 | Fixed | Failed_Login_Events, threshold alerts, and the Admin_Page banner were added. |
| 23 | Full security review | 24 | SR-19, SR-43 to SR-61 | Fixed | `docs/security-review.md` with threat model, OWASP A01 to A10, and 61 Findings. |
| 24 | Tests for every fix | 25 | SR-56, SR-57 | Fixed | 930 unit tests and 8 security e2e tests pass. SR-56 and SR-57 are Deferred. |
| 25 | Security report | 26 | SR-19 | Fixed | This document, linked from `README.md`. |

## Scope and method

- **Scope:** all code, configuration, tests, and documents in this workspace (`server/`, `scripts/`, `src/`, `tests/`, `index.html`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore`, `package.json`, `bun.lock`, `docs/`, `README.md`). Out of scope: the operator's server, nginx, TLS certificates, the OpenAI account, and the remote git repository.
- **What the agent did not do:** the agent did not revoke, rotate, or test any key against OpenAI. It did not rewrite git history, push, or deploy anything. It did not change the operator's server or nginx.
- **Method:** a line-by-line review of the server, scripts, and App_Shell rendering code, and automated tests for every fix and every Already Mitigated control. The review also used the Secret_Scanner, `bun audit`, and a read-only password hash inspection. The full list of files and commands is in [security-review.md, Method](security-review.md#method).
- **Platform:** Windows, Bun 1.4.4, Chrome at the default path. The workspace root is not a git repository.

### Secret scan

| Item | Result |
| --- | --- |
| Command | `bun scripts/scan-secrets.mjs` (workspace root, default allowlist `scripts/secret-allowlist.json`) |
| Date | 2026-11-09 |
| Exit code | 0 |
| Files scanned | 365, including ignored files, `data/`, `dist/`, and binaries (everything outside `node_modules/`) |
| Files skipped (over 50 MB) | 0 |
| Commits scanned | not scanned: the workspace is not a git repository |
| Allowlisted matches | 37 |
| Findings outside the allowlist | 0 |

The first run in this task found 3 matches of the `high-entropy-assignment` rule: `tests/receipt-ai-cost.test.js:20`, `tests/security-pages.e2e.js:10`, and `tests/security-xss.e2e.js:25`. Each line was read and assigns a fixed, readable password constant that the tests use against throwaway local accounts. None is a real credential. Each file got a rule-and-path allowlist entry with a reason in `scripts/secret-allowlist.json`, in the same style as the existing entries. Earlier runs also matched files under `test-results/`. That directory now holds only Playwright's `.last-run.json` and produced no match, so nothing there was deleted or allowlisted.

Key file and history (Requirement 15.9, 16.8):

- `.secrets/openai_api_key` does **not** exist in this workspace, and neither does the `.secrets/` directory.
- `.gitignore:14` and `.dockerignore:18` both exclude `.secrets/`.
- Git history was **not** scanned because this workspace is not a git repository. Whether any commit ever contained the key file or a key is unknown. In the real repository, run `git clone --mirror <your-repository-url> repo.git && bun scripts/scan-secrets.mjs --root repo.git`, or run `bun scripts/scan-secrets.mjs` inside an ordinary clone.
- No real secret was found in the scanned scope: 365 files under the workspace root, no git history, and no HEAD commit because no repository exists. No rotation is required for that scope, so no file needed a secret removed (Requirements 16.1 to 16.3). Requirements 16.4 and 16.6 list no credential and no commit for the same reason. The rotation and history steps in [Operator actions](#operator-actions) apply if the history scan finds something.

### Receipt AI cost estimate (Requirement 18.10)

| Item | Value |
| --- | --- |
| Configured model | `gpt-6-luna` (default of `CAMPING_OPENAI_MODEL_ID`) |
| Image detail | `high` |
| Maximum completion tokens | 6000 |
| Limits | 10 per user per 15 minutes, 100 per UTC day, 1000 per UTC month |
| Input price | USD 0.10 per 1M tokens (Standard, short context) |
| Output price | USD 0.50 per 1M tokens (Standard, short context) |
| Source | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and the [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) |
| Date checked | 2026-11-09 |

The input tokens per request are an **assumption**. The [OpenAI images and vision guide](https://developers.openai.com/api/docs/guides/images-vision) gives patch budgets and token multipliers per model, but neither `gpt-6-luna` table row exists. The estimate therefore uses the `gpt-6-astra` rule for `detail: high`: a 2,500-patch budget and a 1.2 multiplier, which gives at most 3,000 image tokens. It adds 1,000 tokens as an upper bound for the system prompt and instruction text. Assumed input: 4,000 tokens per request. Reasoning tokens count as completion tokens and are capped by `max_completion_tokens`.

The values come from `costEstimate` in `server/ai-cost.js`, run with the defaults, `pricePerMillion = { input: 0.10, output: 0.50 }`, and `imageInputTokens = 4000`:

```text
per request = (4000 × 0.10 + 6000 × 0.50) / 1,000,000 = USD 0.0034
per day     = 0.0034 × 100  = USD 0.34
per month   = 0.0034 × 1000 = USD 3.40
```

The monthly cap is the binding limit, because 100 a day for 31 days would be 3,100 requests. These numbers are maximums: real requests usually produce far fewer than 6,000 completion tokens. Flex and Batch rates are half, and Fast mode is double. The app uses the Standard rate. Regional processing endpoints cost 10% more. If the model or the limits change, recompute with the same formula.

Requirement 18.11: set a monthly budget and usage limit for the OpenAI project in the OpenAI dashboard. See operator action 3.

### Content-Security-Policy keywords (Requirement 11.7)

| Directive | Keyword | App_Shell feature that needs it | Remaining risk |
| --- | --- | --- | --- |
| `style-src` | `'unsafe-inline'` | `style` attributes in the SVG cover and dish illustrations (`src/art.js`, `src/dish-art.js`) | If markup injection were ever found, injected inline styles could change the page's look (for example, overlaying content). They cannot run script, because `script-src` is `'self'` only. Tracked as SR-49 (Accepted Risk). |

No directive contains `'unsafe-eval'`, `'wasm-unsafe-eval'`, or any other `'unsafe-` keyword.

### In-memory rate limits (Requirement 4.8)

The `loginUser`, `loginClient`, `register`, and `invitePreview` Rate_Limiter counters are held in memory, so an App_Server restart resets them (SR-50, Accepted Risk). Receipt AI counts are stored in the Accounts_DB and survive restarts (SR-02). The receipt AI concurrency limit (1 per user, 2 overall) is also held in memory.

## Findings

Full details, evidence, and tests for each Finding are in [security-review.md](security-review.md#findings).

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| SR-01 | Failed logins were not recorded and raised no alert | Low | Fixed |
| SR-02 | Receipt AI limits reset on restart, used a rolling day, had no monthly cap, and recorded no tokens | High | Fixed |
| SR-03 | Model settings were fixed in code, and an invalid model ID silently disabled receipt AI | Low | Fixed |
| SR-04 | Content-Security-Policy and framing headers were weaker than required | Low | Fixed |
| SR-05 | 429 responses had no Retry-After | Info | Fixed |
| SR-06 | No Sec-Fetch-Site check | Low | Fixed |
| SR-07 | JSON handlers checked the session before the content type | Info | Fixed |
| SR-08 | OPTIONS to an unknown API path returned 404 | Info | Fixed |
| SR-09 | The Escape_Function did not escape the backtick | Low | Fixed |
| SR-10 | Login return paths covered only invite pages | Info | Fixed |
| SR-11 | Uncaught API errors left no log line | Low | Fixed |
| SR-12 | The database path guard did not resolve symlinks or check the configured Build_Output | Medium | Fixed |
| SR-13 | The local-handbook import accepted files up to 2,000,000 bytes | Low | Fixed |
| SR-14 | `.dockerignore` did not exclude `.kiro` | Low | Fixed |
| SR-15 | The Example_Nginx_Config had no rule for dot-prefixed paths | Low | Fixed |
| SR-16 | Unused browser OCR path shipped Tesseract and needed `'wasm-unsafe-eval'` | Low | Fixed |
| SR-17 | Obsolete Bedrock region, model, and key variables in the e2e runner | Info | Fixed |
| SR-18 | Git history could not be scanned from this workspace | Medium | Operator Action |
| SR-19 | No security review or report existed | Info | Fixed |
| SR-20 | A corrupt stored password hash could throw during login | Low | Fixed |
| SR-21 | Passwords stored as scrypt with constant-time compare and dummy hash | Info | Already Mitigated |
| SR-22 | Session tokens and cookie attributes | Info | Already Mitigated |
| SR-23 | Expired, unknown, malformed, and soft-deleted sessions treated as signed out | Info | Already Mitigated |
| SR-24 | Login, registration, and invite preview rate limits | Info | Already Mitigated |
| SR-25 | Admin role read from the Accounts_DB on every Admin_API request | Info | Already Mitigated |
| SR-26 | Trip isolation and participant-only ledger and receipt AI | Info | Already Mitigated |
| SR-27 | Every SQL statement uses placeholders | Info | Already Mitigated |
| SR-28 | Server-side validation of JSON bodies and trip state | Info | Already Mitigated |
| SR-29 | Exact Origin match and `SameSite=Strict` cookie | Info | Already Mitigated |
| SR-30 | No CORS headers on any response | Info | Already Mitigated |
| SR-31 | OpenAI_Key used only on the server, errors never forwarded | Info | Already Mitigated |
| SR-32 | Receipt upload type, size, and dimension limits | Info | Already Mitigated |
| SR-33 | Static allowlist, traversal refusal, no sensitive files in build or image | Info | Already Mitigated |
| SR-34 | No debug flags, diagnostic routes, or source maps | Info | Already Mitigated |
| SR-35 | Published_Mode controls (validator, Host allowlist, proxies, no web setup) | Info | Already Mitigated |
| SR-36 | Invite token handling | Info | Already Mitigated |
| SR-37 | Receipt AI policy order, re-check, single call, concurrency | Info | Already Mitigated |
| SR-38 | Service worker never caches `/api/` responses | Info | Already Mitigated |
| SR-39 | No secret in the build or Docker metadata | Info | Already Mitigated |
| SR-40 | User_Content escaped before every HTML_Sink; fixed map links | Info | Already Mitigated |
| SR-41 | Failed session check shows an error and no account data | Info | Already Mitigated |
| SR-42 | Example_Nginx_Config HSTS, body size, no CORS, everything proxied | Info | Already Mitigated |
| SR-43 | Prompt injection through receipt images is contained | Low | Already Mitigated |
| SR-44 | The Rate_Limiter can be made to forget a username lockout | Medium | Deferred |
| SR-45 | Docker local-only first-admin setup trusts a loopback Host header from the container network | Medium | Accepted Risk |
| SR-46 | The error log line can contain an invite token | Low | Deferred |
| SR-47 | nginx access logs record invite URLs | Low | Operator Action |
| SR-48 | Registration reveals whether a username exists | Low | Accepted Risk |
| SR-49 | `'unsafe-inline'` remains in `style-src` | Low | Accepted Risk |
| SR-50 | Login and registration limits are held in memory | Low | Accepted Risk |
| SR-51 | `POST /api/register` answers 409 before 415 while no Admin exists | Info | Accepted Risk |
| SR-52 | Rejected logins write a Failed_Login_Event, which conflicts with "4xx leaves the database unchanged" | Info | Accepted Risk |
| SR-53 | A malformed percent-encoded API path segment gets 400 before the session check | Info | Accepted Risk |
| SR-54 | `scripts/check-accounts.mjs` imports an undeclared package | Info | Deferred |
| SR-55 | Stale build output directories in the workspace | Info | Deferred |
| SR-56 | Pre-existing e2e failures unrelated to security | Info | Deferred |
| SR-57 | No automated test for the failed-session-check page | Info | Deferred |
| SR-58 | `CAMPING_OPENAI_API_KEY_FILE` is a secret variable by Requirement 14.2 but the image sets it | Info | Accepted Risk |
| SR-59 | Some format-restricted server values reach `href` without the Escape_Function | Info | Accepted Risk |
| SR-60 | No second factor and no breached-password check | Info | Accepted Risk |
| SR-61 | A new OpenAI key needs a restart | Info | Accepted Risk |

### Tests for Fixed Findings (Requirement 25.1, 25.2)

"After" is the 2026-11-09 final run, in which every listed test passed. "Before" was **not run**. Each test was written together with its fix, and the pre-fix code was not kept to run it against. The Before column gives the pre-fix behavior that would make the test fail, taken from the code inspection recorded in the requirements Introduction and the Security_Review. Treat it as an expected result, not a measured one.

| Finding | Tests (file "name") | Before (expected, not run) | After |
| --- | --- | --- | --- |
| SR-01 | `tests/security-events.test.js` Properties 28 to 30, "throwing and never-resolving notifiers do not change the login response or block a later notifier", "acknowledging an alert marks it, writes one audit row, and lowers the count"; `tests/security-pages.e2e.js` "admin page shows receipt AI usage and a failed-login alert banner that acknowledgment lowers and hides" | fail: no `security_events` table, store, or admin route existed | pass |
| SR-02 | `tests/receipt-ai-cost.test.js` Properties 23 and 24, "counts survive closing and reopening the database", "503 without a provider call when the usage table cannot be read or written", "admin usage route totals the current UTC day and month and shows the limits" | fail: limits were in memory with a rolling day and no usage table | pass |
| SR-03 | `tests/ai-cost.test.js` "Property 22: one invalid setting throws a ConfigError naming it; valid settings round-trip", "empty environment gives the Requirement 18.1 defaults"; `tests/receipt-ai-cost.test.js` "configured model, detail, and token cap reach the OpenAI request body; one call, no retry" | fail: `server/ai-cost.js` did not exist; model, detail, and token cap were fixed | pass |
| SR-04 | `tests/security-headers.test.js` "SECURITY_HEADERS holds exactly the expected values", "directives match Requirements 9.10, 9.11, 11.2, 11.3, and 13.8", "Property 17: every response carries the security headers exactly once" | fail: `frame-ancestors 'self'`, `'wasm-unsafe-eval'`, `SAMEORIGIN`, no COOP or CORP | pass |
| SR-05 | `tests/security-auth.test.js` "Property 6: Retry-After matches the remaining window" and the four limiter tests "… with Retry-After" | fail: 429 responses had no `Retry-After` | pass |
| SR-06 | `tests/security-csrf.test.js` "Property 15: the CSRF gate follows its decision table", per-route CSRF matrix | fail: `Sec-Fetch-Site: cross-site` with a matching Origin was accepted | pass |
| SR-07 | `tests/security-csrf.test.js` "a JSON_Route without a session and with text/plain gets 415, not 401 (Req 10.3, 10.4)" | fail: returned 401 | pass |
| SR-08 | `tests/security-csrf.test.js` "Property 18: OPTIONS on the API is always 405 and inert", "OPTIONS with a foreign Origin and Access-Control-Request-Method: POST gets 405 and nothing else" | fail: unknown paths returned 404 | pass |
| SR-09 | `tests/model.test.js` "escapes backticks"; `tests/security-client.test.js` "Property 13: escape removes markup characters and decodes back to the input" | fail: backtick passed through unchanged | pass |
| SR-10 | `tests/security-client.test.js` "Property 2: safeNext accepts exactly Private_Page paths and loginPath round-trips them"; `tests/security-pages.e2e.js` "signed-out home, trip and admin pages redirect to login with next and return after sign-in" | fail: `safeNext` accepted only invite paths; redirect had no `next` | pass |
| SR-11 | `tests/security-files.test.js` "Property 25: uncaught errors give the generic body and one safe log line" | fail: no log line for errors caught in `accounts.handle` | pass |
| SR-12 | `tests/security-files.test.js` "Property 27: isPublicDbPath matches the reference model", "Property 27: createAccountService refuses exactly the public paths and creates nothing", "a symlink or junction into the Build_Output or a dist directory is refused", "scripts/serve.mjs exits 1 before listening for a Build_Output path and a public path (Req 20.9)" | fail: symlinks and a custom `CAMPING_DIST` were not checked | pass |
| SR-13 | `tests/security-pages.e2e.js` "local planner import refuses a backup file over 1 MiB without changing the handbook" | fail: files up to 2,000,000 bytes were read | pass |
| SR-14 | `tests/security-config.test.js` ".dockerignore excludes every required entry (Req 20.5)" | fail: `.kiro` missing | pass |
| SR-15 | `tests/security-config.test.js` "dot-prefixed segments return 404 except /.well-known/, before location / (Req 20.8)" | fail: no such `location` rule | pass |
| SR-16 | `tests/security-files.test.js` "no maps, no forbidden files, no OCR, no PUBLISHED flag, and no canary from the environment (Req 13.3, 14.3, 14.4, 19.4, 19.9, 20.4)"; `tests/ocr-assets.e2e.js` "browser OCR assets are gone, CSP has no wasm-unsafe-eval, photos have no public upload route" | fail: `assets/ocr/` was built and served; CSP had `'wasm-unsafe-eval'` | pass |
| SR-17 | `tests/security-config.test.js` "no obsolete Bedrock variable is referenced outside .kiro/, node_modules/, and the Build_Output (Req 22.6)" | fail: `scripts/check-accounts.mjs` set three Bedrock variables | pass |
| SR-19 | none (documents only; see the Security_Review) | — | — |
| SR-20 | `tests/security-auth.test.js` "Property 5: malformed stored hashes fail closed", "a corrupt stored hash gives the wrong-password response and later requests still work" | fail: scrypt threw and gave 500 | pass |

Already Mitigated Findings SR-21 to SR-43 each name their covering test in the Security_Review table "Controls already in place". Each listed test passed in the final run. SR-41 has no test, which is tracked as SR-57 (Deferred). Requirement 25.3 also asks that each such test fails when its control is removed. The agent did not remove controls to check this.

## Changes made

Files added, modified, or deleted by this spec (tasks 1.1 to 13.3), by repository-relative path.

| Path | Change | Description | Findings / Requirements |
| --- | --- | --- | --- |
| `server/safe-log.js` | added | Generic 500 body and the one-line safe error log | SR-11; Req 19 |
| `server/ai-cost.js` | added | AI_Cost_Config parser, UTC boundaries, quota decision, cost estimate | SR-02, SR-03; Req 18 |
| `server/security-events.js` | added | Failed_Login_Event store, alert rules, Alert_Dispatcher | SR-01; Req 23 |
| `server/http.js` | modified | New security headers, no `'wasm-unsafe-eval'`, no OCR paths, safe error log | SR-04, SR-11, SR-16; Req 9, 11, 19 |
| `server/accounts.js` | modified | CSRF gate, `OPTIONS` 405, `Retry-After`, `requireJsonType`, DB path guard, persistent AI quota and usage, failed-login events, new admin routes, fail-closed `verifyPassword` | SR-01, SR-02, SR-05 to SR-08, SR-11, SR-12, SR-20; Req 2, 4, 10, 12, 18, 19, 20, 23 |
| `server/receipt-ai.js` | modified | Configured model, detail, and token cap; usage callback; image helpers from `src/receipt-image.js` | SR-02, SR-03, SR-16; Req 18, 22 |
| `src/auth-paths.js` | added | `safeNext` and `loginPath` for Private_Page return paths | SR-10; Req 1 |
| `src/receipt-image.js` | added | Image helpers moved from the deleted `src/receipt-ocr.js` | SR-16; Req 22 |
| `src/receipt-ocr.js` | deleted | Browser OCR path removed | SR-16; Req 22 |
| `src/model.js` | modified | Escape_Function escapes the backtick | SR-09; Req 9 |
| `src/accounts-ui.js` | modified | Sign-in redirects with `next`, 401 handling, receipt AI usage and login security sections on the Admin_Page | SR-01, SR-02, SR-10; Req 1, 5, 18, 23 |
| `src/accounts.css` | modified | Styles for the new Admin_Page sections | SR-01, SR-02; Req 18, 23 |
| `src/app.js` | modified | 1 MiB local import limit | SR-13; Req 17 |
| `src/receipt-ai-client.js` | modified | Imports image helpers from `src/receipt-image.js` | SR-16; Req 22 |
| `scripts/serve.mjs` | modified | AI_Cost_Config validation at startup, `publicRoots` for the DB path guard | SR-03, SR-12; Req 18, 20 |
| `scripts/build.mjs` | modified | OCR copy step removed; `sw.js` literal and `/demo` guard kept | SR-16; Req 22 |
| `scripts/check-accounts.mjs` | modified | Obsolete Bedrock variables removed | SR-17; Req 22 |
| `scripts/secret-rules.mjs` | added | Secret_Scanner rules, entropy, redaction, allowlist parser | SR-18; Req 15 |
| `scripts/scan-secrets.mjs` | added | Secret_Scanner command | SR-18; Req 15 |
| `scripts/secret-allowlist.json` | added | Allowlist of fake test values, each with a reason | Req 15 |
| `package.json` | modified | Tesseract packages removed | SR-16; Req 22 |
| `bun.lock` | modified | Regenerated without the Tesseract packages | SR-16; Req 22 |
| `.dockerignore` | modified | `.kiro` excluded | SR-14; Req 20 |
| `docs/deploy-nginx.md` | modified | Dot-segment 404 rule; AI_Cost_Config variables in the settings table | SR-15; Req 18, 20 |
| `README.md` | modified | Tesseract sentence removed; key file recommendation; AI_Cost_Config variables; links to the review and this report | Req 14, 18, 22, 26 |
| `docs/security-review.md` | added | Security_Review | SR-19; Req 24 |
| `docs/security-report.md` | added | This report | SR-19; Req 25, 26 |
| `tests/security-client.test.js` | added | Properties 2, 13, 14 | SR-09, SR-10, SR-40; Req 1, 9 |
| `tests/ai-cost.test.js` | added | Property 22 and boundary examples | SR-03; Req 18 |
| `tests/security-events.test.js` | added | Properties 28 to 30 and service examples | SR-01; Req 23 |
| `tests/model.test.js` | modified | Backtick example | SR-09; Req 9 |
| `tests/receipt-image.test.js` | added | Image helper tests and Property 21 | SR-32; Req 17 |
| `tests/receipt-parser.test.js` | modified | OCR-only cases removed; image cases moved | SR-16; Req 22 |
| `tests/ocr-assets.e2e.js` | modified | Rewritten to check that OCR assets are gone | SR-16; Req 22 |
| `tests/security-headers.test.js` | added | Property 17 and header examples | SR-04, SR-30; Req 9, 11, 12, 13 |
| `tests/security-csrf.test.js` | added | Properties 15 and 18 and the CSRF matrix | SR-06 to SR-08, SR-29; Req 10, 12 |
| `tests/security-auth.test.js` | added | Properties 1, 3 to 7, route inventory, cookie and limiter examples | SR-05, SR-20 to SR-25; Req 1 to 5 |
| `tests/security-files.test.js` | added | Properties 25 to 27, static and build checks, key canaries | SR-11, SR-12, SR-16, SR-27, SR-31, SR-33; Req 7, 13, 14, 19, 20 |
| `tests/security-access.test.js` | added | Properties 8 to 12 and 16, SQL payloads | SR-26 to SR-28; Req 6, 7, 8, 10 |
| `tests/receipt-ai.test.js` | modified | Updated for the configured model and the usage callback | SR-03; Req 18 |
| `tests/receipt-ai-cost.test.js` | added | Properties 23 and 24 and quota examples | SR-02, SR-37; Req 18 |
| `tests/security-pages.e2e.js` | added | Login redirects, admin sections and alerts, import limit | SR-01, SR-10, SR-13; Req 1, 5, 6, 17, 18, 23 |
| `tests/security-xss.e2e.js` | added | XSS_Payload_Set on every page | SR-40; Req 1, 9, 11 |
| `tests/security-config.test.js` | added | Document and source checks for nginx, Docker, ignore files, secrets | SR-14, SR-15, SR-17, SR-39, SR-42; Req 11, 12, 14, 17, 19, 20, 22 |
| `tests/secret-scan.test.js` | added | Properties 19 and 20 and scanner examples | SR-18; Req 15 |

## Test results

### Final results

The final results are the task 14 (final checkpoint) runs on 2026-11-09 (local time, UTC+08:00), in the order below. The scanner ran before the e2e runs and again after them, so that files written to `test-results/` by the e2e runs were scanned too.

The first task 14 `bun test tests` run had 929 passed and 1 failed (exit 1). The failure was the generator coverage check after Property 28 in `tests/security-events.test.js`, not a property violation: in 100 random runs the generator never produced a correct-password login for the deleted user, so the reason `deleted_account` was not seen. Such a login is about 0.6% of generated logins. The fix adds that login as a fixed fast-check `examples` entry, so the reason is always exercised. No server code changed. The rerun below passed.

| Command | Date | Passed | Failed | Skipped | Exit code |
| --- | --- | --- | --- | --- | --- |
| `Remove-Item Env:CAMPING_DIST -ErrorAction SilentlyContinue; bun run build` | 2026-11-09 | — | — | — | 0 |
| `bun test tests` (Unit_Suite, 42 files, CAMPING_DIST unset), first run | 2026-11-09 | 929 | 1 | 0 | 1 |
| `bun test tests` (Unit_Suite, 42 files, CAMPING_DIST unset), after the Property 28 test fix | 2026-11-09 | 930 | 0 | 0 | 0 |
| `bun scripts/scan-secrets.mjs` (Secret_Scanner, before the e2e runs) | 2026-11-09 | 364 files, 0 findings, 37 allowlisted, history not scanned | — | — | 0 |
| `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs tests/accounts.e2e.js tests/invite-registration.e2e.js tests/invite-links.e2e.js tests/trip-deletion.e2e.js tests/vehicle-departures.e2e.js tests/brand.e2e.js tests/ocr-assets.e2e.js tests/receipt-ocr.e2e.js` (E2E_Suite, PBN set) | 2026-11-09 | 28 | 8 | 0 | 1 |
| `node scripts/check-accounts.mjs tests/security-pages.e2e.js tests/security-xss.e2e.js` (E2E_Suite, security set) | 2026-11-09 | 8 | 0 | 0 | 0 |
| `bun scripts/scan-secrets.mjs` (Secret_Scanner, after the e2e runs) | 2026-11-09 | 364 files, 0 findings, 37 allowlisted, history not scanned | — | — | 0 |
| `bun audit` (Dependency_Audit, 6 packages; task 13.1, not rerun in task 14) | 2026-11-09 | 0 advisories | — | — | 0 |

The e2e artifacts in `test-results/` produced no new scanner findings.

Failed and skipped (Requirement 26.8):

- The 8 PBN-set e2e failures are the same 8 tests that failed in the baseline: `tests/brand.e2e.js:40`, `:55`, `:80`, `:93`; `tests/receipt-ocr.e2e.js:43`; `tests/trip-deletion.e2e.js:83`, `:140`; and `tests/vehicle-departures.e2e.js:245`. They are caused by UI copy changes, a home-card timeout, and the shared `register` limit across files in one invocation. They are tracked as SR-56 (Deferred) and listed under [Remaining risks](#remaining-risks).
- No unit or e2e test was skipped.
- The full set of 25 e2e files was not run in one invocation after the changes. In the baseline, that run hit the shared `register` limit of 20 per hour for `127.0.0.1` (see the baseline list). The final e2e runs are the PBN set and the security set. The other 17 of the 27 `tests/*.e2e.js` files were not rerun after the changes: `account-identity`, `accounts-auth`, `app`, `assignment-motion`, `avatar-preview`, `daily-life`, `expenses`, `gear-presets`, `ingredients`, `maps`, `meal-image-hidden`, `meal-layout`, `mobile-swipe`, `picker`, `recipes-invites`, `schedule-bar`, and `vehicle-itinerary`. Task 14 runs the two required invocations. A full-run comparison with the baseline remains open (see Remaining risks).

Baseline tests whose expectation changed (Requirement 25.7):

| Baseline test | Change | Finding |
| --- | --- | --- |
| `tests/receipt-parser.test.js` "receipt OCR input checks > sniffs only JPEG, PNG and WebP bytes", "> reads header dimensions before decoding", "> enforces size, type and 20-million pixel limits with Chinese messages" | Moved unchanged to `tests/receipt-image.test.js` "receipt image helpers > …" with the same names; pass | SR-16 |
| `tests/receipt-parser.test.js` "receipt OCR input checks > plans modest resizing that keeps aspect ratio", "> rejects already-aborted requests and non-files without loading OCR" | Removed with the browser OCR code they tested (`planOcrSize`, `recognizeReceipt`) | SR-16 |
| `tests/ocr-assets.e2e.js:5` "OCR assets are same-origin and on demand, CSP allows only WASM evaluation, photos have no public upload route" | Rewritten as "browser OCR assets are gone, CSP has no wasm-unsafe-eval, photos have no public upload route"; pass | SR-16 |

Every other baseline unit test still exists and passes. The Unit_Suite grew from 602 to 930 tests.

### Baseline

Recorded on 2026-11-09 (local time, UTC+08:00) on Windows with Bun 1.4.4 and Chrome at the default path `C:/Program Files/Google/Chrome/Application/chrome.exe`. No source, test, or configuration file had been changed by this spec when these runs were made.

#### Summary

| Suite | Command | Passed | Failed | Skipped | Exit code |
| --- | --- | --- | --- | --- | --- |
| Build | `Remove-Item Env:CAMPING_DIST -ErrorAction SilentlyContinue; bun run build` | — | — | — | 0 |
| Unit_Suite | `bun test tests` (CAMPING_DIST unset) | 602 | 0 | 0 | 0 |
| E2E_Suite, PBN file set | `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs tests/accounts.e2e.js tests/invite-registration.e2e.js tests/invite-links.e2e.js tests/trip-deletion.e2e.js tests/vehicle-departures.e2e.js tests/brand.e2e.js tests/ocr-assets.e2e.js tests/receipt-ocr.e2e.js` | 28 | 8 | 0 | 1 |
| E2E_Suite, all 25 e2e files | `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs` (no file arguments, so Playwright runs every `tests/*.e2e.js`) | 150 | 18 | 0 | 1 |

The Unit_Suite ran 602 tests across 30 files in about 46 seconds. The PBN e2e set took 5.3 minutes and the full e2e run took 9.5 minutes.

#### Baseline e2e failures

These tests already failed before this spec changed anything. Requirement 25.7 compares the final runs with this list.

Failures in the PBN file set:

| Test | Cause seen in the Playwright output |
| --- | --- |
| tests/brand.e2e.js:40, :55, :93 | The test expects the brand name 日子拾光 in `footer`; the footer now shows a different text (UI copy changed after the test was written). |
| tests/brand.e2e.js:80 | The test expects the attribution sentence 依「好好露營」視覺與工作流程獨立製作 in `main` of the demo route; the page shows a different data note. |
| tests/receipt-ocr.e2e.js:43 | The test expects `.xp-receipt` to contain `OpenAI 辨識完成`; the page shows the result under the heading `AI 辨識結果` with different copy. |
| tests/trip-deletion.e2e.js:83 | Timed out after 60 s waiting for the `刪除旅行` button on the home trip card. |
| tests/trip-deletion.e2e.js:140, tests/vehicle-departures.e2e.js:245 | `POST /api/register` returned 429 `註冊嘗試太多次，請稍後再試。`: the files in one invocation share one server and one `register` limit of 20 attempts per hour for `127.0.0.1`. |

The full run has the same eight failures plus ten more. Seven of the extra failures are the same `register` 429 (tests/gear-presets.e2e.js:180, tests/meal-image-hidden.e2e.js:101 and :144, tests/invite-links.e2e.js:103 and :174, tests/invite-registration.e2e.js:75 and :150), because all 25 files share one `register` bucket; the invite-links and invite-registration tests pass in the smaller PBN invocation, and the gear-presets and meal-image-hidden files were not rerun on their own. The other three are UI assertion failures: tests/expenses.e2e.js:208 finds 2 edit-icon SVGs where it expects 1; tests/meal-layout.e2e.js:71 reads the meal slot 消夜 where it expects 早餐; tests/picker.e2e.js:86 finds the first gear assignee option hidden where it expects it visible. Full list of failing tests in the full run:

- tests/brand.e2e.js:40 public login and registration use the new brand
- tests/brand.e2e.js:55 home, admin, trip, departure and invitation keep consistent branding without rewriting trip data
- tests/brand.e2e.js:80 demo routes retain browser data and original-site attribution while changing the visible brand
- tests/brand.e2e.js:93 new brand fits home and trip headers from phone to desktop in both themes
- tests/expenses.e2e.js:208 repayment lowers outstanding balance, and owner removal recalculates totals after confirmation
- tests/gear-presets.e2e.js:180 account trip suggestions never touch server until saved and preserve existing gear
- tests/invite-links.e2e.js:103 owner and member lists show the right open links and a revoked link stops working
- tests/invite-links.e2e.js:174 member at the 5-link limit sees the limit in the dialog, revokes one and creates again
- tests/invite-registration.e2e.js:75 signed-out visitor sees the preview above the form, registers, lands on the trip; a second visitor gets the invalid-link page
- tests/invite-registration.e2e.js:150 invite preview renders trip and inviter text without injecting markup
- tests/meal-image-hidden.e2e.js:101 account edits preserve an explicitly saved image while legacy automatic meals stay automatic
- tests/meal-image-hidden.e2e.js:144 account template still updates hidden artwork but cancelling never changes saved data
- tests/meal-layout.e2e.js:71 five-slot dropdown saves and moves a card immediately, preserving other meal fields and shopping
- tests/picker.e2e.js:86 keyboard selection saves; Escape only closes the picker inside an edit dialog
- tests/receipt-ocr.e2e.js:43 selecting a receipt automatically sends it to GPT-6 Luna and displays editable candidates
- tests/trip-deletion.e2e.js:83 admin can cancel then confirm own trip deletion from home on phone and desktop (1.0m)
- tests/trip-deletion.e2e.js:140 admin deletes another owner trip in backend, revokes link and leaves other trips and account intact
- tests/vehicle-departures.e2e.js:245 collaborators can edit departures but cannot delete cars; strangers cannot read the trip

#### Unit_Suite results (`bun test tests`)

| File | Test | Result |
| --- | --- | --- |
| tests/accounts.test.js | upgrades existing trip cover constraints without losing trips or members | pass |
| tests/accounts.test.js | routing and transport > non-api paths are left to the static server | pass |
| tests/accounts.test.js | routing and transport > unknown api routes and hard delete are rejected as JSON errors | pass |
| tests/accounts.test.js | routing and transport > responses are JSON and never cached | pass |
| tests/accounts.test.js | routing and transport > mutations need the exact request origin (CSRF) | pass |
| tests/accounts.test.js | routing and transport > JSON content type, object bodies and the 1 MB limit are enforced | pass |
| tests/accounts.test.js | first-admin setup > setup is loopback-only | pass |
| tests/accounts.test.js | first-admin setup > container mode only allows setup through a loopback host | pass |
| tests/accounts.test.js | first-admin setup > creates an admin, sets a hardened cookie and runs only once | pass |
| tests/accounts.test.js | first-admin setup > cookie is Secure on https | pass |
| tests/accounts.test.js | first-admin setup > concurrent setup requests create exactly one admin | pass |
| tests/accounts.test.js | first-admin setup > validates username, display name and password with no defaults | pass |
| tests/accounts.test.js | registration, login and sessions > registration requires setup and creates members | pass |
| tests/accounts.test.js | registration, login and sessions > registration cannot self-grant admin | pass |
| tests/accounts.test.js | registration, login and sessions > registration attempts are rate limited | pass |
| tests/accounts.test.js | registration, login and sessions > login is generic on failure and bounded per username | pass |
| tests/accounts.test.js | registration, login and sessions > sessions expire after 7 days and logout revokes them | pass |
| tests/accounts.test.js | registration, login and sessions > login rotates the presented session | pass |
| tests/accounts.test.js | registration, login and sessions > forged or malformed cookies are rejected | pass |
| tests/accounts.test.js | registration, login and sessions > passwords and hashes never appear in responses | pass |
| tests/accounts.test.js | trips and isolation > creates a valid empty trip owned by a new owner participant | pass |
| tests/accounts.test.js | trips and isolation > accepts and persists every cover illustration option | pass |
| tests/accounts.test.js | trips and isolation > validates card fields | pass |
| tests/accounts.test.js | trips and isolation > accounts only see their own or joined trips; admin sees all | pass |
| tests/accounts.test.js | trips and isolation > legacy import copies data, adds a fresh owner and syncs ingredients | pass |
| tests/accounts.test.js | trips and isolation > legacy import with new dates shifts the schedule | pass |
| tests/accounts.test.js | trips and isolation > SQL-like and HTML text is stored as plain text | pass |
| tests/accounts.test.js | editing, revisions and tampering > owner PUT saves server-authoritative state and increments revision | pass |
| tests/accounts.test.js | editing, revisions and tampering > stale revisions conflict | pass |
| tests/accounts.test.js | editing, revisions and tampering > account-bound edits cannot be replayed under an admin or another editor session | pass |
| tests/accounts.test.js | editing, revisions and tampering > members can edit, patch and invite | pass |
| tests/accounts.test.js | editing, revisions and tampering > bound participants cannot be removed or swapped, but can be renamed | pass |
| tests/accounts.test.js | editing, revisions and tampering > invalid or tampered state is rejected without saving | pass |
| tests/accounts.test.js | editing, revisions and tampering > client audit events cannot spoof actor, time or history | pass |
| tests/accounts.test.js | editing, revisions and tampering > an unbound admin edits as admin while seeing the owner perspective | pass |
| tests/accounts.test.js | editing, revisions and tampering > PATCH edits card metadata and shifts schedule dates | pass |
| tests/accounts.test.js | member check-offs > members tick any shared shopping item but only their own packing | pass |
| tests/accounts.test.js | member check-offs > departure requires own packing complete | pass |
| tests/accounts.test.js | member check-offs > hosts may tick any shopping item; unbound admins cannot pack for others | pass |
| tests/accounts.test.js | member check-offs > check-offs honour revisions | pass |
| tests/accounts.test.js | invites > owner creates hashed, expiring invite links | pass |
| tests/accounts.test.js | invites > preview requires login and reports membership | pass |
| tests/accounts.test.js | invites > joining adds a new bound participant, is idempotent and blocks impersonation | pass |
| tests/accounts.test.js | invites > invites expire after 7 days and capacity is bounded | pass |
| tests/accounts.test.js | admin user management > admin endpoints are admin-only | pass |
| tests/accounts.test.js | admin user management > roles change per request, with self and last-admin protection | pass |
| tests/accounts.test.js | admin user management > cannot delete self, the last admin or without confirmation | pass |
| tests/accounts.test.js | admin user management > soft delete revokes access, reassigns trips and detaches participant references | pass |
| tests/accounts.test.js | admin user management > deleting a member of a full 100-person trip keeps the trip valid | pass |
| tests/accounts.test.js | admin user management > an admin cannot be locked out by stale client role flags | pass |
| tests/accounts.test.js | service rejects public database locations and closes cleanly | pass |
| tests/accounts.test.js | requests after close fail closed | pass |
| tests/accounts.test.js | a session revoked while the body is still uploading cannot commit | pass |
| tests/accounts.test.js | admin trip soft deletion > owner, member and anonymous callers are denied without changes | pass |
| tests/accounts.test.js | admin trip soft deletion > exact confirmation title, current revision and expected identity are all required | pass |
| tests/accounts.test.js | admin trip soft deletion > admin deletes another user's trip; it is hidden and unreachable everywhere | pass |
| tests/accounts.test.js | admin trip soft deletion > admin can delete their own trip and account deletion still transfers remaining trips | pass |
| tests/accounts.test.js | admin trip soft deletion > role demoted or session revoked during a slow body cannot commit | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > list and envelope expose capabilities; forged permission fields are ignored | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > invited members edit titles, cards, items and assignments | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > members cannot remove existing items through whole-state PUT; owners can | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > recipe edits by members may auto-prune untouched generated rows only | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > members cannot relabel manual rows as generated to prune them later | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > bought generated rows unticked by members are retained when the recipe changes | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > members cannot rewrite other accounts or pack for others; own packing still works | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > delete matrix: outsiders 404, guests 403, owners only their own, admins any | pass |
| tests/accounts.test.js | collaborator edit and owner-only delete rights > identity, revision and ownership are rechecked after a slow body | pass |
| tests/art.test.js | cover illustration choices render distinct, complete SVG scenes | pass |
| tests/assignment.test.js | inline shopping assignment changes only responsible person and manual preservation marker | pass |
| tests/assignment.test.js | manually assigned generated ingredients survive meal removal and sync | pass |
| tests/assignment.test.js | clear assignment works and invalid or unchanged assignments do not mutate state | pass |
| tests/build-sw.test.js | built service worker > starts with exactly one PUBLISHED=false flag, has the /demo guard and mode-dependent cache name | pass |
| tests/build-sw.test.js | built service worker > Published_Mode /sw.js is rewritten to PUBLISHED=true with no false flag left | pass |
| tests/build-sw.test.js | built service worker > Published_Mode worker leaves /demo navigations to the network but handles /login | pass |
| tests/build-sw.test.js | built service worker > Local_Mode worker handles /demo/ navigations | pass |
| tests/create-admin.test.js | runCreateAdmin > creates the administrator with audit setup.cli and never shows or stores the password | pass |
| tests/create-admin.test.js | runCreateAdmin > uses http://127.0.0.1:<PORT> when no public origin is set | pass |
| tests/create-admin.test.js | runCreateAdmin > refuses when a user already exists and leaves the database unchanged | pass |
| tests/create-admin.test.js | runCreateAdmin > prints the validation message and asks again for an invalid username | pass |
| tests/create-admin.test.js | runCreateAdmin > stops after 5 invalid usernames without creating an account | pass |
| tests/create-admin.test.js | runCreateAdmin > a mismatched confirmation prints the message and re-asks both password entries | pass |
| tests/create-admin.test.js | runCreateAdmin > a password argument exits 2 with usage before any prompt | pass |
| tests/create-admin.test.js | runCreateAdmin > --help prints usage and exits 0 | pass |
| tests/create-admin.test.js | runCreateAdmin > without a terminal it exits 1 with TTY_REQUIRED | pass |
| tests/create-admin.test.js | runCreateAdmin > CAMPING_ADMIN_PASSWORD in the environment is ignored | pass |
| tests/create-admin.test.js | runCreateAdmin > :memory: is refused with exit 1 before opening a service | pass |
| tests/create-admin.test.js | runCreateAdmin > ended input exits 1 without creating an account | pass |
| tests/create-admin.test.js | createFirstAdmin concurrency > two services on the same file: exactly one succeeds, the other gets 409 | pass |
| tests/create-admin.test.js | createFirstAdmin concurrency > runCreateAdmin reports a concurrent creation as already complete | pass |
| tests/create-admin.test.js | askHidden > reads without echo, handles backspace, and restores raw mode | pass |
| tests/create-admin.test.js | askHidden > Ctrl+D on an empty buffer rejects and restores raw mode | pass |
| tests/create-admin.test.js | askHidden > Ctrl+C restores raw mode and calls exit(130) | pass |
| tests/create-admin.test.js | askHidden > stream end rejects | pass |
| tests/daily-notes.test.js | 60 original, unique plain-text notes fit a small card | pass |
| tests/daily-notes.test.js | same Taiwan calendar day always has the same note regardless of timestamp zone | pass |
| tests/daily-notes.test.js | Taipei midnight advances to the next note | pass |
| tests/daily-notes.test.js | all 60 notes appear before a repeat, including negative epoch days | pass |
| tests/daily-notes.test.js | year-end and leap-day boundaries remain correct | pass |
| tests/daily-notes.test.js | refresh updates only note nodes at midnight or wake, schedules once and cleans up | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: valid configurations > empty environment equals LOCAL_DEFAULTS with today's behavior | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: valid configurations > Published_Mode for https://www.our-littlemoments.com | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: valid configurations > Published_Mode normalizes the origin and accepts explicit closed registration | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: valid configurations > a non-loopback bind is accepted with the explicit opt-in or Docker_Local_Only | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.1 Published_Mode without a public origin | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.2 Published_Mode with an http: origin | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.3 origin with a path, query, fragment, or credentials | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.4 non-loopback bind host without the opt-in | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.5 Published_Mode with Docker_Local_Only | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.6 invalid trusted proxy entry | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.7 registration policy and receipt AI seed outside their values | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.8 invalid local extra host entry | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.9 Published_Mode with local extra hosts | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.10 Boolean_Setting with a value other than 1 or 0 | pass |
| tests/deploy-config.test.js | parseDeploymentConfig: each Requirement 2 rejection > 2.12 / 13.18 CAMPING_REGISTRATION=open with CAMPING_PUBLISHED=1 | pass |
| tests/deploy-config.test.js | client address selection > trusted peer uses the forwarded client address | pass |
| tests/deploy-config.test.js | client address selection > untrusted peer with spoofed forwarding headers keeps the peer address | pass |
| tests/deploy-config.test.js | client address selection > multiple X-Forwarded-For entries select the right-most untrusted entry | pass |
| tests/deploy-config.test.js | client address selection > an invalid selected entry is rejected with 400 | pass |
| tests/deploy-config.test.js | client address selection > proxied request in Published_Mode uses the public origin and Secure cookies | pass |
| tests/deploy-config.test.js | formatStartupLines > Published_Mode lines name origin, bind address, registration, and receipt AI policy | pass |
| tests/deploy-config.test.js | formatStartupLines > Local_Mode lines match today's messages | pass |
| tests/deploy-config.test.js | formatStartupLines > no line contains the OpenAI API key when CAMPING_OPENAI_API_KEY is set | pass |
| tests/deploy-config.test.js | client address selection: properties > Property 1: client address follows the trusted-proxy selection rule | pass |
| tests/deploy-config.test.js | client address selection: properties > Property 2: prepended forwarding entries cannot change the client address | pass |
| tests/deploy-config.test.js | client address selection: properties > Property 3: IPv4 and IPv4-mapped IPv6 are the same address | pass |
| tests/deploy-config.test.js | host and origin decisions: properties > Property 4: host allowlist matches the mode model | pass |
| tests/deploy-config.test.js | host and origin decisions: properties > Property 5: expected origin and cookie security depend only on mode and proxy status | pass |
| tests/deploy-config.test.js | configuration parsing: properties > Property 7: invalid setting values stop startup with a named error | pass |
| tests/deploy-config.test.js | configuration parsing: properties > Property 8: configuration normalization is idempotent | pass |
| tests/dish-art.test.js | dishIllustration > exports exactly the supported kinds | pass |
| tests/dish-art.test.js | dishIllustration > hotpot renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > bbq renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > toast renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > curry renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > pasta renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > breakfast renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > salad renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > custom renders a self-contained accessible wide svg | pass |
| tests/dish-art.test.js | dishIllustration > hotpot markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > bbq markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > toast markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > curry markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > pasta markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > breakfast markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > salad markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > custom markup is balanced with no duplicate attributes | pass |
| tests/dish-art.test.js | dishIllustration > each named dish kind draws distinct artwork | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for undefined | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "unknown" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for null | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for 42 | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "constructor" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "__proto__" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "toString" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "HOTPOT" | pass |
| tests/dish-art.test.js | dishIllustration > falls back to custom for "hotpot\"><script>" | pass |
| tests/dish-art.test.js | dishIllustration > defaults to custom | pass |
| tests/dish-art.test.js | dishIllustration > randomizes generic food art while keeping specific art stable | pass |
| tests/dish-art.test.js | dishIllustration > appends and escapes className on the wrapper only | pass |
| tests/expense-model.test.js | parseAmount > parses TWD text and numbers into positive integer cents | pass |
| tests/expense-model.test.js | parseAmount > rejects zero, negative, oversized, imprecise and malformed input | pass |
| tests/expense-model.test.js | parseAmount > error messages are Chinese and user-facing | pass |
| tests/expense-model.test.js | formatMoney > prints TWD with grouping, cents only when present, negatives allowed | pass |
| tests/expense-model.test.js | formatMoney > rejects non-integer cents | pass |
| tests/expense-model.test.js | splitEvenly > conserves the total and gives remainders to the first sorted ids | pass |
| tests/expense-model.test.js | splitEvenly > result is independent of input order | pass |
| tests/expense-model.test.js | splitEvenly > conservation holds across many amounts and group sizes | pass |
| tests/expense-model.test.js | splitEvenly > rejects invalid amounts and participants | pass |
| tests/expense-model.test.js | summarizeLedger > positive net means should receive; includes everyone in ledger.people | pass |
| tests/expense-model.test.js | summarizeLedger > repayments add to sender and subtract from receiver | pass |
| tests/expense-model.test.js | summarizeLedger > overpaying a repayment flips direction instead of losing money | pass |
| tests/expense-model.test.js | summarizeLedger > nets always sum to zero and transfers clear every balance, remainders included | pass |
| tests/expense-model.test.js | summarizeLedger > deterministic for equal balances and keeps historical ids not in people | pass |
| tests/expense-model.test.js | summarizeLedger > empty ledger summarizes to zeros | pass |
| tests/expense-model.test.js | summarizeLedger > rejects non-integer money rows | pass |
| tests/gear-presets.test.js | camping essentials are grouped, uniquely named, and have valid suggested quantities | pass |
| tests/http.test.js | clean account routes serve only the shell with no-store and security headers | pass |
| tests/http.test.js | database, source, backups and encoded traversal are never served | pass |
| tests/http.test.js | unexpected hostname rejected even if DNS points to localhost | pass |
| tests/http.test.js | IP literal host such as a LAN address is accepted in Local_Mode | pass |
| tests/http.test.js | apex hostname is rejected in Published_Mode before reaching the account service | pass |
| tests/http.test.js | rejected host never reaches the account service in Local_Mode | pass |
| tests/http.test.js | protected API response never falls back to shell or cache | pass |
| tests/http.test.js | static files reject writes and malformed paths | pass |
| tests/ingredients.test.js | ingredient parsing and classification > accepts ideographic/Chinese/English commas, semicolons and newlines | pass |
| tests/ingredients.test.js | ingredient parsing and classification > discards empty tokens and deduplicates normalized names | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 牛肉片 as 肉類 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 豬五花 as 肉類 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 雞胸肉 as 肉類 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 香腸 as 肉類 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 培根 as 肉類 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 鮭魚 as 海鮮 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 白蝦 as 海鮮 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 蛤蜊 as 海鮮 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 花枝 as 海鮮 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 高麗菜 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 金針菇 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 地瓜葉 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 玉米 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 甜椒 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 辣椒 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 薑 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 毛豆 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 番茄 as 蔬菜 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 蘋果 as 水果 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 水果 as 水果 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 雞蛋 as 蛋奶 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 鮮奶 as 蛋奶 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 奶油 as 蛋奶 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 起司 as 蛋奶 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 板豆腐 as 豆製品 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 豆皮 as 豆製品 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 素雞 as 豆製品 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 吐司 as 主食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 貝果 as 主食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 白米 as 主食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 義大利麵 as 主食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 地瓜 as 主食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 壽喜燒醬 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 雞粉 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 魚露醬 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 花生醬 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 辣椒粉 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 肉桂粉 as 調味料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 咖啡豆 as 飲料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 燕麥奶 as 飲料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 蘋果汁 as 飲料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 豆漿 as 飲料 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 棉花糖 as 零食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 牛肉乾 as 零食 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 冰塊 as 其他 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies 神秘食材 as 其他 | pass |
| tests/ingredients.test.js | ingredient parsing and classification > classifies constructor as 其他 | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > creates categorized entries with explicit unknown quantities and valid schema | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > same names across meals stay one row and repeated sync is a no-op | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > meal edits remove only unused generated entries; shared needs remain | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > purchased items, manual rows and user-edited auto rows survive removing meals | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > existing/manual matched entries keep identity, quantity, category and buyer | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > legacy combined rows cover each ingredient without duplicating their quantities | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > clearing a recipe removes obsolete references and retains purchased entries | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > new category and linkage metadata round-trip through old schema version | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > rejects malformed source metadata and nonexistent meal references | pass |
| tests/ingredients.test.js | recipe-to-shopping synchronization > capacity failure leaves original list untouched | pass |
| tests/ingredients.test.js | halfwidth separators normalize before parsing, numeric commas stay in the item | pass |
| tests/ingredients.test.js | a manual duplicate supersedes a generated row without losing details | pass |
| tests/ingredients.test.js | purchased orphans stay after being unchecked; manual orphans are visibly marked | pass |
| tests/ingredients.test.js | only one legacy duplicate is linked so the other remains removable | pass |
| tests/ingredients.test.js | one-way storage migration preserves original data and ignores later old-tab writes | pass |
| tests/ingredients.test.js | specific product classification: 茶葉蛋 | pass |
| tests/ingredients.test.js | specific product classification: 蒜味香腸 | pass |
| tests/ingredients.test.js | specific product classification: 薑母鴨 | pass |
| tests/ingredients.test.js | specific product classification: 鹽酥雞 | pass |
| tests/ingredients.test.js | specific product classification: 洋蔥豬肉 | pass |
| tests/ingredients.test.js | specific product classification: 番茄牛腩 | pass |
| tests/ingredients.test.js | specific product classification: 蒜蓉蝦 | pass |
| tests/ingredients.test.js | specific product classification: 吳郭魚 | pass |
| tests/ingredients.test.js | specific product classification: 蠔油 | pass |
| tests/ingredients.test.js | specific product classification: 柳橙汁 | pass |
| tests/ingredients.test.js | specific product classification: 蜂蜜蛋糕 | pass |
| tests/ingredients.test.js | specific product classification: 玉米片 | pass |
| tests/ingredients.test.js | specific product classification: 梅花豬 | pass |
| tests/ingredients.test.js | seasoning names remain recognizable: 醬油 1瓶 | pass |
| tests/ingredients.test.js | seasoning names remain recognizable: 醬油膏 | pass |
| tests/ingredients.test.js | seasoning names remain recognizable: 鹽 1包 | pass |
| tests/ingredients.test.js | seasoning names remain recognizable: 鹽麴 | pass |
| tests/ingredients.test.js | ingredient delimiters support slash and periods with numeric decimal preservation | pass |
| tests/invite-list.test.js | invite list scope > owner and admin outside the trip see every Active_Invite; a Trip_Member sees only their own | pass |
| tests/invite-list.test.js | invite list scope > outsider gets 404, no session gets 401, and an empty list is 200 | pass |
| tests/invite-list.test.js | invite list exposes no secrets > the body has no token, token hash, account id or username, and entries have exactly four keys | pass |
| tests/invite-list.test.js | invite list contents > used, expired and revoked invites are left out; the rest is newest first | pass |
| tests/invite-list.test.js | Invite_ID migration > a pre-feature invites table gets distinct UUID ids that persist, and the old links list and revoke by id | pass |
| tests/invite-list.test.js | invite list and revoke-by-id properties > Property 16: the invite list shows exactly the revocable Active_Invites and never exposes tokens | pass |
| tests/invite-list.test.js | invite list and revoke-by-id properties > Property 17: revoke by id follows the creator-or-manager rule | pass |
| tests/invites.test.js | invitation preview > a Valid_Invite previews with exactly the public fields, with or without a session | pass |
| tests/invites.test.js | invitation preview > preview and invite page responses carry no-store and no-referrer through createHttpHandler | pass |
| tests/invites.test.js | invitation preview > the 61st preview from one Client_Address gets 429 while another address still gets 200 | pass |
| tests/invites.test.js | invitation preview > preview leaves the link unused and the trip unchanged | pass |
| tests/invites.test.js | invitation preview > GET /api/invites/<token> still needs a session | pass |
| tests/invites.test.js | trip members can invite > canInvite capability for owner, Trip_Member, admin outside the trip and outsider | pass |
| tests/invites.test.js | trip members can invite > a Trip_Member creates a link with the invite.create audit entry | pass |
| tests/invites.test.js | trip members can invite > the 6th member link is 409 while the owner can still create links | pass |
| tests/invites.test.js | trip members can invite > deleting an account revokes its links | pass |
| tests/invites.test.js | trip members can invite > demoting an admin revokes links for trips where the account is neither owner nor member | pass |
| tests/invites.test.js | trip members can invite > a demoted admin's old link previews as 404 even without the revocation | pass |
| tests/invites.test.js | single-use links > after an Invite_Join a second account gets 404; the joined account and the owner see alreadyMember | pass |
| tests/invites.test.js | single-use links > after an Invite_Registration a second account gets 404 | pass |
| tests/invites.test.js | single-use links > a failed join leaves used_at NULL and the link still works | pass |
| tests/invites.test.js | single-use links > two concurrent joins through one link add one member | pass |
| tests/invites.test.js | single-use links > the same single-use rules apply in Published_Mode | pass |
| tests/invites.test.js | invites usage-column migration > an old invites table upgrades in place with rows kept and the old link usable once | pass |
| tests/invites.test.js | per-link revoke by Invite_ID > the create response has a UUID id that is neither the token nor its hash | pass |
| tests/invites.test.js | per-link revoke by Invite_ID > creator, owner and admin outside the trip revoke with 200 and invite.revoke; the link then previews 404 | pass |
| tests/invites.test.js | per-link revoke by Invite_ID > another Trip_Member gets 403 and the link stays active | pass |
| tests/invites.test.js | per-link revoke by Invite_ID > malformed, unknown, other-trip, used, revoked and expired ids are 404 and change nothing | pass |
| tests/invites.test.js | per-link revoke by Invite_ID > outsider 404, no session 401, foreign Origin 403, and no token-based revoke route | pass |
| tests/invites.test.js | invitation preview properties > Property 12: the invitation preview returns exactly the public fields | pass |
| tests/invites.test.js | invitation preview properties > Property 13: unusable invitation links are indistinguishable | pass |
| tests/invites.test.js | single-use link property > Property 14: an invitation link adds at most one account | pass |
| tests/invites.test.js | invite limit property > Property 15: invite creation follows the active-invite limits | pass |
| tests/ledger.test.js | ledger read > GET returns an empty schema-1 ledger with trip people and permissions, without writing | pass |
| tests/ledger.test.js | ledger read > unauthenticated, outsiders and non-member admins cannot see the ledger | pass |
| tests/ledger.test.js | ledger read > mutations require the same origin and JSON | pass |
| tests/ledger.test.js | ledger write > PUT stores money rows separately; trip state and revision are untouched | pass |
| tests/ledger.test.js | ledger write > text is trimmed and the response is the normalized server copy | pass |
| tests/ledger.test.js | ledger write > stale revision and stale or missing identity are rejected without writing | pass |
| tests/ledger.test.js | ledger write > identical retry with the same requestId is idempotent; reuse with a different body fails | pass |
| tests/ledger.test.js | ledger write > members add and edit any row but cannot remove rows; owners can | pass |
| tests/ledger.test.js | ledger write > backend rejects bad rows with Chinese messages and stores nothing | pass |
| tests/ledger.test.js | ledger write > hostile nesting is rejected as 400 before hashing, never a stack overflow | pass |
| tests/ledger.test.js | ledger write > boundary values are accepted: max amount, 1 cent, early purchase dates, 100 participants | pass |
| tests/ledger.test.js | ledger write > receipt rows need a fingerprint and unique line per file | pass |
| tests/ledger.test.js | ledger write > row limits are 1000 expenses and 1000 settlements | pass |
| tests/ledger.test.js | ledger write > shopping links validate only when new or changed and never mark items bought | pass |
| tests/ledger.test.js | ledger isolation and lifecycle > old whole-state PUT with stray money fields cannot change the ledger | pass |
| tests/ledger.test.js | ledger isolation and lifecycle > deleting the trip hides the ledger for everyone | pass |
| tests/ledger.test.js | ledger isolation and lifecycle > deleting a member account keeps their debt and name snapshot, never reassigning it | pass |
| tests/ledger.test.js | ledger isolation and lifecycle > removing an unbound participant in the trip keeps the name they had in the ledger | pass |
| tests/ledger.test.js | re-authentication after slow bodies > logout while the body is still uploading rejects the write | pass |
| tests/ledger.test.js | re-authentication after slow bodies > account deletion during upload rejects the write and ledger stays unchanged | pass |
| tests/ledger.test.js | re-authentication after slow bodies > a concurrent ledger save during upload makes the slow write stale | pass |
| tests/ledger.test.js | re-authentication after slow bodies > trip deletion during upload rejects the write | pass |
| tests/ledger.test.js | database upgrade > an existing database gains an empty trip_ledgers table without rewriting rows; GET writes nothing; corrupt rows are never overwritten | pass |
| tests/maps.test.js | Google Maps search encodes real address as query on fixed origin | pass |
| tests/maps.test.js | injected URL, delimiters and quotes cannot replace destination or markup | pass |
| tests/maps.test.js | blank and very long legacy addresses stay readable without invalid URLs | pass |
| tests/maps.test.js | vehicle meeting label can keep original time but search only location | pass |
| tests/meal-order.test.js | five meal slots follow chronological order | pass |
| tests/meal-order.test.js | date is sorted before slot, with stable order for same-slot dishes | pass |
| tests/meal-order.test.js | display sorting does not mutate data or stored array order | pass |
| tests/meal-order.test.js | older aliases have the expected time order | pass |
| tests/meal-order.test.js | unknown legacy slots appear after known slots on the same date, unchanged | pass |
| tests/meal-order.test.js | legacy form option is preserved, not silently replaced with dinner | pass |
| tests/meal-order.test.js | new forms have only the five choices and choices are independent copies | pass |
| tests/meal-order.test.js | empty menu returns no date groups | pass |
| tests/mobile-swipe.test.js | the pure layer imports without a DOM and agrees with its documented examples | pass |
| tests/mobile-swipe.test.js | mulberry32 is seeded, in range, and reproducible | pass |
| tests/mobile-swipe.test.js | runAll drives at least 200 iterations from the seeded generator | pass |
| tests/mobile-swipe.test.js | a failing property reports the seed and the JSON sample so it can be replayed | pass |
| tests/mobile-swipe.test.js | harness: the generator path reaches the pure layer | pass |
| tests/mobile-swipe.test.js | property 4: resolveAxis returns exactly one of horizontal, vertical or unresolved | pass |
| tests/mobile-swipe.test.js | property 4: resolveAxis leaves the axis unresolved while both displacements sit inside the 8px dead zone | pass |
| tests/mobile-swipe.test.js | property 4: an already-resolved axis lock sticks for any later displacement | pass |
| tests/mobile-swipe.test.js | property 1: trackOffset tracks the finger one-to-one inside the linear zone | pass |
| tests/mobile-swipe.test.js | property 1: the linear zone includes both of its boundaries | pass |
| tests/mobile-swipe.test.js | trackOffset returns the displacement itself across the linear zone of a real two-action row | pass |
| tests/mobile-swipe.test.js | property 2: the rendered offset never escapes the range from the rubber-band floor to zero | pass |
| tests/mobile-swipe.test.js | the bounds generator visits every region of trackOffset, including the capped floor | pass |
| tests/mobile-swipe.test.js | property 2: a row dragged rightward past zero holds the rendered offset at exactly zero | pass |
| tests/mobile-swipe.test.js | property 2: an overshoot past the cap renders exactly at the rubber-band floor | pass |
| tests/mobile-swipe.test.js | trackOffset stays inside its bounds across a real two-action row | pass |
| tests/mobile-swipe.test.js | property 3: past the end stop the row renders 0.3 of the raw overshoot beyond it, capped at 48px | pass |
| tests/mobile-swipe.test.js | property 3: trackOffset is monotonic, so of two raw sums the smaller never renders to the right of the larger | pass |
| tests/mobile-swipe.test.js | the property 3 generators reach every overshoot band and straddle every region boundary | pass |
| tests/mobile-swipe.test.js | trackOffset renders three tenths of the overshoot past a real two-action row, up to 48px | pass |
| tests/mobile-swipe.test.js | property 9: reduced motion changes trackOffset only past the end stop, where it holds the row at exactly the end stop | pass |
| tests/mobile-swipe.test.js | the property 9 generator reaches every region and lands on the end stop, one step from it, and a hair from it | pass |
| tests/mobile-swipe.test.js | reduced motion holds a real two-action row at its end stop for drags the band would stretch | pass |
| tests/mobile-swipe.test.js | property 5: sampleVelocity gives the same value as it gives for the samples within 100ms of the last one | pass |
| tests/mobile-swipe.test.js | property 5: prepending samples more than 100ms older than the last one leaves the velocity unchanged | pass |
| tests/mobile-swipe.test.js | the property 5 generators reach every clock and step, both window edges, and every outcome | pass |
| tests/mobile-swipe.test.js | property 5: sampleVelocity is null, never 0, for fewer than two samples or a window collapsed onto one instant | pass |
| tests/mobile-swipe.test.js | property 5: a finger moving left measures a negative velocity and one moving right a positive velocity | pass |
| tests/mobile-swipe.test.js | the window keeps a sample exactly 100ms older than the last and drops one a hair older | pass |
| tests/mobile-swipe.test.js | sampleVelocity returns null, never 0, when there is no rate to measure, and exactly 0 for a finger held still | pass |
| tests/mobile-swipe.test.js | a real 60Hz flick measures its own direction over the final 100ms, whatever came before | pass |
| tests/mobile-swipe.test.js | property 6: a flick of at least 0.35px/ms resolves by its direction alone, whatever the offset, displacement, axis or prior state | pass |
| tests/mobile-swipe.test.js | property 6: a velocity a hair under 0.35px/ms is no flick, so the halfway rule decides instead of the direction | pass |
| tests/mobile-swipe.test.js | property 6, inert-row exception: a row with no actions has an End_Stop of 0 and resolves closed even for a leftward flick | pass |
| tests/mobile-swipe.test.js | the property 6 generators reach every speed, offset region and axis, both sides of the threshold, and flicks with every input against them | pass |
| tests/mobile-swipe.test.js | a flick decides a real two-action row by its direction, and one double under the threshold the halfway rule decides | pass |
| tests/mobile-swipe.test.js | property 7: under 0.35px/ms the halfway rule decides, whatever the speed, direction, displacement, axis or prior state | pass |
| tests/mobile-swipe.test.js | property 7: an offset of exactly half the end stop opens and the next double toward zero closes | pass |
| tests/mobile-swipe.test.js | property 7: a slow release from inside the rubber band opens, because past the end stop is past half | pass |
| tests/mobile-swipe.test.js | the property 7 generators reach every speed band and offset region, the halfway point and the doubles beside it, and releases with every other input against the offset | pass |
| tests/mobile-swipe.test.js | below the threshold a real two-action row resolves by its 68px halfway point, whatever the speed, direction, displacement or prior state | pass |
| tests/mobile-swipe.test.js | property 8: with no measured velocity and a horizontal release axis, 56px leftward opens, 42px rightward closes, and the prior state stands in between | pass |
| tests/mobile-swipe.test.js | property 8: exactly 56px leftward opens and exactly 42px rightward closes, and the next double toward zero from either keeps the prior state | pass |
| tests/mobile-swipe.test.js | property 8: with no measured velocity a release whose axis is not horizontal keeps the prior state, whatever the displacement | pass |
| tests/mobile-swipe.test.js | the property 8 generators reach both lock states, every band and offset region, both thresholds and the doubles beside them, and releases with every other input against the outcome | pass |
| tests/mobile-swipe.test.js | the tests/app.e2e.js swipe opens a real two-action row by the distance rule, and the same release measured at 0 stays closed | pass |
| tests/mobile-swipe.test.js | property 10: a gesture suppresses the click that follows if and only if its axis locked horizontal or it travelled at least 42px either way | pass |
| tests/mobile-swipe.test.js | the property 10 generator reaches every axis state and travel band, and each clause alone, neither, and both | pass |
| tests/mobile-swipe.test.js | exactly 42px of travel either way suppresses the click and one double toward zero does not, when the lock is not horizontal | pass |
| tests/mobile-swipe.test.js | a tap, with no horizontal travel and no horizontal lock, leaves the click alone | pass |
| tests/mobile-swipe.test.js | the tests/app.e2e.js swipe and a 20px flick suppress the click that follows, and a tap and a vertical scroll do not | pass |
| tests/mobile-swipe.test.js | frame writer: over any run of pushes, frames, cancels and flushes it writes what a reference model writes, at the same steps, and never twice in one frame | pass |
| tests/mobile-swipe.test.js | frame writer: the generator reaches long bursts, a second writing frame, a frame after a dropped value, cancels and flushes with a frame pending and with none, idle frames, and repeats | pass |
| tests/mobile-swipe.test.js | frame writer: many pushes before a frame write nothing until the frame runs, then write once with the newest value, from one raf call | pass |
| tests/mobile-swipe.test.js | frame writer: a push after the frame ran schedules a new frame, and the next burst writes once with its own newest value | pass |
| tests/mobile-swipe.test.js | frame writer: cancel drops the pending write by handing its frame to caf, and calls no caf when nothing is pending | pass |
| tests/mobile-swipe.test.js | frame writer: a cancelled frame that a browser runs anyway never writes the cancelled value | pass |
| tests/mobile-swipe.test.js | frame writer: flushTarget writes at once, before any frame, and cancels a pending frame so its value is never written | pass |
| tests/mobile-swipe.test.js | frame writer: push, flushTarget and cancel behave the same when destructured off the writer | pass |
| tests/mobile-swipe.test.js | frame writer: a write that pushes again schedules a fresh frame instead of being swallowed | pass |
| tests/mobile-swipe.test.js | property 11: releaseVelocity is the slope from the earliest move in the 100ms before the release to the release, 0 when none falls there, and null only with no move | pass |
| tests/mobile-swipe.test.js | property 11: a fast drag released more than 100ms after its last move measures exactly 0, where the old rule measured a flick | pass |
| tests/mobile-swipe.test.js | property 11: releaseVelocity is null for a trace with no move and a number for every other trace sampleVelocity cannot measure on its own | pass |
| tests/mobile-swipe.test.js | the property 11 generators reach every clock, release gap and window edge, every outcome, fast pauses both ways, and every unmeasured trace | pass |
| tests/mobile-swipe.test.js | releaseVelocity is null with no move, the tests/app.e2e.js gesture, and pairs one move with the release: 0 on its tick, their slope within 100ms, 0 past it | pass |
| tests/mobile-swipe.test.js | a fast 40px drag over three frames flicks when released straight after its last move, and measures 0 after a 200ms pause | pass |
| tests/model.test.js | local camping model > demo data has a valid complete schema | pass |
| tests/model.test.js | local camping model > validates date ranges and leap days | pass |
| tests/model.test.js | local camping model > persists and restores changes | pass |
| tests/model.test.js | local camping model > new and malformed local storage starts from a blank valid planner | pass |
| tests/model.test.js | local camping model > storage failures are reported, not treated as saved | pass |
| tests/model.test.js | local camping model > nested malformed backup data is rejected | pass |
| tests/model.test.js | local camping model > unknown active identity is rejected | pass |
| tests/model.test.js | local camping model > packing marks belong to the chosen participant | pass |
| tests/model.test.js | local camping model > cannot tick another participants shared equipment | pass |
| tests/model.test.js | local camping model > unassigned group items block departure | pass |
| tests/model.test.js | local camping model > departure succeeds only after assignment and own packing | pass |
| tests/model.test.js | local camping model > reassigning clears obsolete readiness and departure | pass |
| tests/model.test.js | local camping model > unknown assignment is not accepted | pass |
| tests/model.test.js | local camping model > progress includes personal gear for each participant | pass |
| tests/model.test.js | local camping model > renders untrusted text as escaped text | pass |
| tests/model.test.js | local camping model > SVG art does not allow class injection | pass |
| tests/model.test.js | rejects hidden categories and unknown gear assignees in backups | pass |
| tests/model.test.js | rejects out of trip dates and duplicate passengers | pass |
| tests/model.test.js | rejects normalized invalid dates and spans longer than one month | pass |
| tests/publish.test.js | proxied login in Published_Mode > Origin equal to the Public_Origin logs in and gets a Secure session cookie | pass |
| tests/publish.test.js | proxied login in Published_Mode > a forwarded request carrying the request URL origin instead of the Public_Origin is refused | pass |
| tests/publish.test.js | proxied login in Published_Mode > Local_Mode login over plain http keeps the cookie without Secure | pass |
| tests/publish.test.js | web first-admin setup is gone in Published_Mode > /setup and /setup/ return 404 for proxied and direct-local requests | pass |
| tests/publish.test.js | web first-admin setup is gone in Published_Mode > POST /api/setup returns the API 404 for proxied, direct-local, and bad-Origin requests | pass |
| tests/publish.test.js | web first-admin setup is gone in Published_Mode > Local_Mode still serves /setup and accepts POST /api/setup from loopback | pass |
| tests/publish.test.js | one dist serves both modes > /demo and /demo/ return 404 in Published_Mode and 200 in Local_Mode | pass |
| tests/publish.test.js | one dist serves both modes > the shared app chunk and entry script stay available in Published_Mode | pass |
| tests/publish.test.js | one dist serves both modes > the deployment meta tag is injected only in Published_Mode | pass |
| tests/publish.test.js | one dist serves both modes > sw.js gets const PUBLISHED=true; only in Published_Mode | pass |
| tests/publish.test.js | registration policy > Local_Mode open registration creates an account | pass |
| tests/publish.test.js | registration policy > Local_Mode with CAMPING_REGISTRATION=closed refuses registration | pass |
| tests/publish.test.js | registration policy > Published_Mode refuses valid, malformed, and empty bodies without spending the register bucket | pass |
| tests/publish.test.js | registration policy > GET /api/session reports the flags for each mode | pass |
| tests/publish.test.js | per-client rate limiting behind nginx > two proxied clients with different X-Forwarded-For use separate loginClient buckets | pass |
| tests/publish.test.js | origin check properties > POST /api/logout returns 200 iff Origin equals the expected origin, else 403 請求來源不被允許。 | pass |
| tests/publish.test.js | rate-limit isolation properties > RateLimiter: blocked(key) equals replaying only that key's hits on a fresh limiter | pass |
| tests/publish.test.js | rate-limit isolation properties > register bucket per Local_Mode client address matches a per-address model | pass |
| tests/publish.test.js | rate-limit isolation properties > a proxied client at the loginClient limit never blocks other X-Forwarded-For addresses | pass |
| tests/publish.test.js | invite registration > Published proxied: creates a member in the trip, consumes the link, sets a Secure cookie, and writes audits | pass |
| tests/publish.test.js | invite registration > works under both registration policies in Local_Mode, including closed | pass |
| tests/publish.test.js | invite registration > invalid, used, and expired tokens return 404 and create nothing | pass |
| tests/publish.test.js | invite registration > a taken username returns 409 and leaves the link unused | pass |
| tests/publish.test.js | invite registration > a trip name conflict returns 409 with no new user and the link still usable | pass |
| tests/publish.test.js | invite registration > Local_Mode: invite registration and POST /api/register share one register bucket per Client_Address | pass |
| tests/publish.test.js | invite registration > Published_Mode: POST /api/register does not spend the bucket; invite registration is limited per X-Forwarded-For | pass |
| tests/publish.test.js | invite registration > a bad Origin returns 403 and leaves the link unused | pass |
| tests/publish.test.js | invite registration > with no users in the database, invite registration returns 409 | pass |
| tests/publish.test.js | invite registration > Property 11: new users equal 200 responses, each joins the trip, failures leave nothing, used_by marks the winner | pass |
| tests/publish.test.js | receipt AI policy > each policy set by an admin applies to the next status and recognition request, with an audit entry | pass |
| tests/publish.test.js | receipt AI policy > without a configured key, status reports unconfigured where the policy permits and policy where it excludes | pass |
| tests/publish.test.js | receipt AI policy > with nothing stored the seed applies, and without a seed the default is all in both modes | pass |
| tests/publish.test.js | receipt AI policy > GET /api/admin/settings reports the stored value, time, and admin | pass |
| tests/publish.test.js | receipt AI policy > a member gets 403 for GET and PATCH, and invalid values get 400, leaving the stored value unchanged | pass |
| tests/publish.test.js | receipt AI policy > a file-backed database keeps the stored value across service instances, and it beats the seed | pass |
| tests/receipt-ai.test.js | expanded categories preserve old values and local suggestions distinguish fuel and food | pass |
| tests/receipt-ai.test.js | normalizer uses only extracted exact amounts and allowed categories; sums independently | pass |
| tests/receipt-ai.test.js | uncertain or total rows never become ready amounts; no numeric guessing | pass |
| tests/receipt-ai.test.js | quantity discrepancies require review and do not replace printed line amount | pass |
| tests/receipt-ai.test.js | server image validation bounds size, type, dimensions and truncation | pass |
| tests/receipt-ai.test.js | limited streams reject undeclared oversize payload and cancel | pass |
| tests/receipt-ai.test.js | unconfigured or invalid OpenAI credentials never invoke provider or leak key | pass |
| tests/receipt-ai.test.js | default OpenAI model is GPT-6 Luna | pass |
| tests/receipt-ai.test.js | OpenAI contract sends bounded image JSON to the fixed API with no tools or retries | pass |
| tests/receipt-ai.test.js | provider failures, refusals, truncation, huge output and invalid JSON cannot leak body or credentials | pass |
| tests/receipt-ai.test.js | provider cancellation/timeout aborts network, does not retry or return late candidates | pass |
| tests/receipt-ai.test.js | receipt API requires auth, matching session, membership, Origin and explicit per-photo consent | pass |
| tests/receipt-ai.test.js | successful AI recognition writes no trip/ledger; status never exposes credentials; unconfigured fails closed | pass |
| tests/receipt-ai.test.js | per-user quota and in-flight lock prevent excess provider calls | pass |
| tests/receipt-ai.test.js | logout during provider processing blocks releasing recognition result | pass |
| tests/receipt-ai.test.js | mixed new and original category values persist without extra ledger fields or trip changes | pass |
| tests/receipt-ai.test.js | joined collaborators can recognize but an unrelated administrator cannot | pass |
| tests/receipt-fixture.test.js | Google Maps links only use explicit link navigation, no geolocation or API key | pass |
| tests/receipt-parser.test.js | receipt parser > parses a normal Traditional Chinese receipt and skips metadata/summary lines | pass |
| tests/receipt-parser.test.js | receipt parser > never turns total, subtotal, cash, change or tax into expense items | pass |
| tests/receipt-parser.test.js | receipt parser > line IDs are stable per source line and unique for repeated items | pass |
| tests/receipt-parser.test.js | receipt parser > does not guess OCR numeric noise | pass |
| tests/receipt-parser.test.js | receipt parser > accepts full-width digits, currency marks, thousands and two decimals strictly | pass |
| tests/receipt-parser.test.js | receipt parser > negative or keyword discounts are exposed as warnings, not items | pass |
| tests/receipt-parser.test.js | receipt parser > preserves quantity rows and flags inconsistent arithmetic | pass |
| tests/receipt-parser.test.js | receipt parser > merges a title-only line with its following quantity line | pass |
| tests/receipt-parser.test.js | receipt parser > reports a mismatch between items and the printed total | pass |
| tests/receipt-parser.test.js | receipt parser > states the mismatch direction with an unsigned difference | pass |
| tests/receipt-parser.test.js | receipt parser > conflicting totals are not trusted | pass |
| tests/receipt-parser.test.js | receipt parser > detects invoice, store, address, timestamp, phone and product-ID lines as metadata | pass |
| tests/receipt-parser.test.js | receipt parser > exposes unknown lines and missing totals | pass |
| tests/receipt-parser.test.js | receipt parser > rejects zero, oversized and nameless amounts for review | pass |
| tests/receipt-parser.test.js | receipt parser > handles empty or non-string input safely | pass |
| tests/receipt-parser.test.js | receipt parser > formats cents without floating point | pass |
| tests/receipt-parser.test.js | receipt OCR input checks > sniffs only JPEG, PNG and WebP bytes | pass |
| tests/receipt-parser.test.js | receipt OCR input checks > reads header dimensions before decoding | pass |
| tests/receipt-parser.test.js | receipt OCR input checks > enforces size, type and 20-million pixel limits with Chinese messages | pass |
| tests/receipt-parser.test.js | receipt OCR input checks > plans modest resizing that keeps aspect ratio | pass |
| tests/receipt-parser.test.js | receipt OCR input checks > rejects already-aborted requests and non-files without loading OCR | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > templates cover registered artwork and have valid classified ingredients | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > applying preset merges ingredients without mutating draft, dates, cook or servings | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > quick ingredients merge normalized names and reject no input safely | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > unknown preset fails without data change | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > existing demo meals get matching pictures without data migration | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > infers 咖哩飯 | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > infers 番茄義大利麵 | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > infers 野餐沙拉 | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > infers 不知道吃什麼 | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > explicit type wins; invalid type cannot inject markup | pass |
| tests/recipes-invites.test.js | recipe templates and matching art > saved template retains schema and shopping sync | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > adds a unique person without mutating existing data or taking an identity | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > normalizes fullwidth characters and internal spaces | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "" | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "   " | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "　" | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "​" | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "‮Jack" | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects invalid name "樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹樹" | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > rejects duplicate existing person rather than impersonating | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > duplicate names compare normalized spelling and case | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > checks role length and total participant cap | pass |
| tests/recipes-invites.test.js | invitation creates a new independent person > invalid additions preserve packing while valid new member clears readiness declaration | pass |
| tests/recipes-invites.test.js | emoji joined names work while invisible lookalikes and empty names are rejected | pass |
| tests/recipes-invites.test.js | recognizes common grilled dish 烤雞 | pass |
| tests/recipes-invites.test.js | recognizes common grilled dish 烤魚 | pass |
| tests/recipes-invites.test.js | recognizes common grilled dish 烤玉米 | pass |
| tests/scene-motion.test.js | art layers > camp keeps original transforms and adds layer wrappers | pass |
| tests/scene-motion.test.js | art layers > other kinds still render and unknown kind falls back to camp | pass |
| tests/scene-motion.test.js | animatedIllustration > wraps only the original svg, with no controls and no external resources | pass |
| tests/scene-motion.test.js | animatedIllustration > sanitizes kind in class | pass |
| tests/scene-motion.test.js | animatedIllustration > supports full-frame artwork without cropping or a baked-in background | pass |
| tests/scene-motion.test.js | animatedIllustration > stays control-free whatever the motion state | pass |
| tests/scene-motion.test.js | sceneMotionSettings > renders a small section with heading, copy and a native toggle | pass |
| tests/scene-motion.test.js | sceneMotionSettings > reflects paused preference at render time | pass |
| tests/scene-motion.test.js | sceneMotionSettings > reduced motion hides the toggle and shows the note at render time | pass |
| tests/scene-motion.test.js | setupSceneMotion > static before setup | pass |
| tests/scene-motion.test.js | setupSceneMotion > sets root attribute, idempotent listener | pass |
| tests/scene-motion.test.js | setupSceneMotion > toggle persists separate preference and never touches travel data | pass |
| tests/scene-motion.test.js | setupSceneMotion > clicks on the icon inside a toggle nested in <details> still toggle every control | pass |
| tests/scene-motion.test.js | setupSceneMotion > restores pause and rerendered markup reflects it; sync updates new buttons | pass |
| tests/scene-motion.test.js | setupSceneMotion > ignores clicks elsewhere | pass |
| tests/scene-motion.test.js | setupSceneMotion > reduced motion is static, hides buttons, ignores toggles, reacts to changes | pass |
| tests/scene-motion.test.js | setupSceneMotion > storage failures fall back to memory | pass |
| tests/scene-motion.test.js | setupSceneMotion > teardown removes listeners and attribute | pass |
| tests/scene-motion.test.js | van motion layers > removing motion-only wrappers restores byte-identical original art | pass |
| tests/scene-motion.test.js | van motion layers > wrappers add no primitives and keep viewBox, coordinates and colours | pass |
| tests/scene-motion.test.js | van motion layers > wrappers carry only classes, never transforms or paint | pass |
| tests/scene-motion.test.js | van motion layers > only the animated hero gets the van layers inside .scene-motion; thumbnails stay plain | pass |
| tests/scene-motion.test.js | scene-motion.css > animations only under no-preference and running/paused root | pass |
| tests/scene-motion.test.js | scene-motion.css > only transform/opacity are animated, no external urls | pass |
| tests/scene-motion.test.js | scene-motion.css > toggle lives in the settings flow, never over the art, and is hidden for reduced/print | pass |
| tests/scene-motion.test.js | scene-motion.css > van drive and bounce are restrained, scoped and covered by pause/reduced/print | pass |
| tests/settings.test.js | policy constants | pass |
| tests/settings.test.js | resolveReceiptAiPolicy: exhaustive stored × seed table | pass |
| tests/settings.test.js | Property 10: Receipt AI decision follows the policy table | pass |
| tests/trip-delete-upgrade.test.js | existing account database gains deletion metadata without rewriting users or trip contents | pass |
| tests/trip-delete-upgrade.test.js | closing file-backed account service releases SQLite handles without garbage collection | pass |
| tests/trip-menu.test.js | section tabs are exactly the five remaining keys in order | pass |
| tests/trip-menu.test.js | the removed tab keys resolve to schedule | pass |
| tests/trip-menu.test.js | the storage key is unchanged | pass |
| tests/trip-menu.test.js | Property 1: Tab resolution is identity on Remaining_Tabs and schedule elsewhere | pass |
| tests/trip-menu.test.js | with no account the menu has every fixed entry | pass |
| tests/trip-menu.test.js | Property 2: Every person gets an entry, with edit rights matching the old crew tab | pass |
| tests/trip-menu.test.js | Property 3: Every vehicle gets an edit entry, and a delete entry exactly when deletion is allowed | pass |
| tests/trip-menu.test.js | Property 4: The menu shows the most recent events in stored order | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > reads existing meeting format without modifying it | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > keeps unstructured and invalid time strings intact as location | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > handles time-only, empty and multiline data | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > round-trips untouched legacy text byte-for-byte | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > writes the existing schema rather than adding new required fields | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > location can be saved without a guessed time | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > rejects invalid time, blank location and excess combined length | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > untouched long legacy text is preserved but edits respect the limit | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > sorts first-day cars by departure time with unknown times last and stable ties | pass |
| tests/vehicle-departures.test.js | vehicle departure compatibility > other days and empty fleets do not invent departures | pass |
| tests/vehicle-itinerary.test.js | validActivityVehicles > absent vehicleIds keeps every legacy people shape valid | pass |
| tests/vehicle-itinerary.test.js | validActivityVehicles > accepts a nonempty unique list of existing vehicle IDs with no people | pass |
| tests/vehicle-itinerary.test.js | validActivityVehicles > rejects empty, duplicate, unknown and non-string IDs | pass |
| tests/vehicle-itinerary.test.js | validActivityVehicles > rejects a car selection that conflicts with explicit people | pass |
| tests/vehicle-itinerary.test.js | validActivityVehicles > rejects IDs once the referenced car is gone | pass |
| tests/vehicle-itinerary.test.js | isValidState with vehicle itineraries > seed and legacy activities stay valid without vehicleIds | pass |
| tests/vehicle-itinerary.test.js | isValidState with vehicle itineraries > accepts per-car activities | pass |
| tests/vehicle-itinerary.test.js | isValidState with vehicle itineraries > rejects every malformed selection and conflicting people | pass |
| tests/vehicle-itinerary.test.js | isValidState with vehicle itineraries > deleting a referenced car invalidates the state until activities are reassigned | pass |
| tests/vehicle-itinerary.test.js | activityForVehicle > explicit selection includes only the chosen cars | pass |
| tests/vehicle-itinerary.test.js | activityForVehicle > legacy empty or full people lists apply to every car | pass |
| tests/vehicle-itinerary.test.js | activityForVehicle > legacy explicit people intersect with the car driver and passengers | pass |
| tests/vehicle-itinerary.test.js | activityForVehicle > legacy explicit people do not match an empty car | pass |
| tests/vehicle-itinerary.test.js | activityForVehicle > does not mutate state | pass |
| tests/vehicle-itinerary.test.js | activityForPerson > selected cars include their driver and passengers only | pass |
| tests/vehicle-itinerary.test.js | activityForPerson > membership follows the current car roster rather than a stored copy | pass |
| tests/vehicle-itinerary.test.js | activityForPerson > people outside every car are not in a car-only activity | pass |
| tests/vehicle-itinerary.test.js | activityForPerson > legacy empty people means everyone, explicit people stay exact | pass |
| tests/vehicle-itinerary.test.js | activityParticipantLabel > selected cars show car names, never 全體旅伴 | pass |
| tests/vehicle-itinerary.test.js | activityParticipantLabel > legacy empty or full people show 全體旅伴 | pass |
| tests/vehicle-itinerary.test.js | activityParticipantLabel > legacy partial people show names joined with 、 | pass |
| tests/vehicle-itinerary.test.js | activityParticipantLabel > a once-full list stops being 全體旅伴 after someone new joins | pass |
| tests/vehicle-itinerary.test.js | independent car itineraries > one car reaching camp does not change the other car itinerary | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > legacy import keeps vehicleIds and leaves legacy activities without the field | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > legacy states without vehicleIds still import and save unchanged in shape | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > PUT stores vehicleIds and GET returns them | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > malformed selections and conflicting people are rejected atomically | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > a car referenced by an activity cannot be deleted until activities are reassigned | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > unrelated PUT and PATCH edits preserve vehicleIds | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > each car itinerary stays independent after one car reaches camp | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > invited members can assign cars but cannot delete a car; outsiders cannot edit | pass |
| tests/vehicle-itinerary.test.js | account API round-trip > a stale save cannot overwrite a newer car assignment | pass |

#### E2E_Suite results, PBN file set

| Test location | Test | Result |
| --- | --- | --- |
| tests/accounts.e2e.js:97 | account home clean URL, multiple cards, edit history and no demo storage writes | pass |
| tests/accounts.e2e.js:151 | cover illustrations show previews and persist a newly selected scene | pass |
| tests/accounts.e2e.js:176 | owner recipe template saves isolated server state and shopping with inline assignment selector | pass |
| tests/accounts.e2e.js:209 | two accounts cannot view each others home or trip or call admin APIs | pass |
| tests/accounts.e2e.js:241 | invited guest edits shared content but cannot delete trip or remove items | pass |
| tests/accounts.e2e.js:344 | trip menu for a non-owner member hides vehicle delete, import and reset | pass |
| tests/accounts.e2e.js:394 | admin edits another owner trip and disables account without deleting travel history | pass |
| tests/accounts.e2e.js:440 | stale revisions preserve unsaved planner edits instead of overwriting newer data | pass |
| tests/accounts.e2e.js:466 | protected API responses are absent from offline caches and logout revokes access | pass |
| tests/accounts.e2e.js:494 | responsive home, admin and assignee selectors fit 320px through desktop | pass |
| tests/brand.e2e.js:40 | public login and registration use the new brand | fail |
| tests/brand.e2e.js:55 | home, admin, trip, departure and invitation keep consistent branding without rewriting trip data | fail |
| tests/brand.e2e.js:80 | demo routes retain browser data and original-site attribution while changing the visible brand | fail |
| tests/brand.e2e.js:93 | new brand fits home and trip headers from phone to desktop in both themes | fail |
| tests/invite-links.e2e.js:103 | owner and member lists show the right open links and a revoked link stops working | pass |
| tests/invite-links.e2e.js:174 | member at the 5-link limit sees the limit in the dialog, revokes one and creates again | pass |
| tests/invite-registration.e2e.js:75 | signed-out visitor sees the preview above the form, registers, lands on the trip; a second visitor gets the invalid-link page | pass |
| tests/invite-registration.e2e.js:150 | invite preview renders trip and inviter text without injecting markup | pass |
| tests/ocr-assets.e2e.js:5 | OCR assets are same-origin and on demand, CSP allows only WASM evaluation, photos have no public upload route | pass |
| tests/receipt-ocr.e2e.js:43 | selecting a receipt automatically sends it to GPT-6 Luna and displays editable candidates | fail |
| tests/receipt-ocr.e2e.js:87 | OpenAI failure stops recognition without local OCR or automatic retry | pass |
| tests/trip-deletion.e2e.js:57 | home omits legacy and local notices without changing saved demo data | pass |
| tests/trip-deletion.e2e.js:83 | admin can cancel then confirm own trip deletion from home on phone and desktop (1.0m) | fail |
| tests/trip-deletion.e2e.js:140 | admin deletes another owner trip in backend, revokes link and leaves other trips and account intact | fail |
| tests/trip-deletion.e2e.js:189 | stale revision and failed deletion keep card and show error instead of success | pass |
| tests/trip-deletion.e2e.js:234 | home hides the JSON import entry but retains validated import for future use | pass |
| tests/vehicle-departures.e2e.js:52 | separate starts show sorted first-day cars and leave the shared schedule and data unchanged | pass |
| tests/vehicle-departures.e2e.js:77 | editing in the schedule syncs to the trip menu and reload; editing in the trip menu syncs back | pass |
| tests/vehicle-departures.e2e.js:127 | empty fleet can add cars directly without creating duplicate activities, validates seats and location | pass |
| tests/vehicle-departures.e2e.js:193 | free-form legacy meeting text is not guessed or overwritten on unrelated edits | pass |
| tests/vehicle-departures.e2e.js:212 | unsaved vehicle drafts and stale saves never overwrite the newer server plan | pass |
| tests/vehicle-departures.e2e.js:245 | collaborators can edit departures but cannot delete cars; strangers cannot read the trip | fail |
| tests/vehicle-departures.e2e.js:298 | cards fit mobile and desktop, long or untrusted text stays safe, print retains departure plans | pass |
| tests/vehicle-departures.e2e.js:349 | demo can save departure changes and reload them offline | pass |
| tests/vehicle-departures.e2e.js:375 | empty and time-only legacy locations can keep their data on an unrelated vehicle edit | pass |
| tests/vehicle-departures.e2e.js:393 | owner removal from the schedule also removes the same car from the trip menu without touching activities | pass |

#### E2E_Suite results, all e2e files

| Test location | Test | Result |
| --- | --- | --- |
| tests/account-identity.e2e.js:31 | account home removes stale owner data when a second tab logs out | pass |
| tests/account-identity.e2e.js:72 | planner hides stale trip when another tab switches accounts without an open draft | pass |
| tests/account-identity.e2e.js:114 | dirty owner draft cannot be retried after switching to an admin account | pass |
| tests/accounts-auth.e2e.js:3 | registration and login forms create account-specific URL and reject mismatched passwords | pass |
| tests/accounts.e2e.js:97 | account home clean URL, multiple cards, edit history and no demo storage writes | pass |
| tests/accounts.e2e.js:151 | cover illustrations show previews and persist a newly selected scene | pass |
| tests/accounts.e2e.js:176 | owner recipe template saves isolated server state and shopping with inline assignment selector | pass |
| tests/accounts.e2e.js:209 | two accounts cannot view each others home or trip or call admin APIs | pass |
| tests/accounts.e2e.js:241 | invited guest edits shared content but cannot delete trip or remove items | pass |
| tests/accounts.e2e.js:344 | trip menu for a non-owner member hides vehicle delete, import and reset | pass |
| tests/accounts.e2e.js:394 | admin edits another owner trip and disables account without deleting travel history | pass |
| tests/accounts.e2e.js:440 | stale revisions preserve unsaved planner edits instead of overwriting newer data | pass |
| tests/accounts.e2e.js:466 | protected API responses are absent from offline caches and logout revokes access | pass |
| tests/accounts.e2e.js:494 | responsive home, admin and assignee selectors fit 320px through desktop | pass |
| tests/app.e2e.js:10 | new local planner starts blank and reset stays blank | pass |
| tests/app.e2e.js:46 | dashboard renders and all planning tabs work | pass |
| tests/app.e2e.js:84 | invite lets a new companion type their name and persists membership | pass |
| tests/app.e2e.js:108 | create, edit, and remove an itinerary entry | pass |
| tests/app.e2e.js:156 | mobile list rows reveal edit and delete actions by swiping left | pass |
| tests/app.e2e.js:196 | mobile planner keeps its first section close and selected navigation visible | pass |
| tests/app.e2e.js:239 | meal card removes directly with an X after confirmation | pass |
| tests/app.e2e.js:273 | shopping checkboxes persist, filter, and survive offline reload | pass |
| tests/app.e2e.js:319 | existing meal ingredients sync on upgrade once without duplicate combined items | pass |
| tests/app.e2e.js:340 | departure is blocked by unassigned shared items, then succeeds | pass |
| tests/app.e2e.js:372 | can add a person and validate vehicle capacity | pass |
| tests/app.e2e.js:412 | invalid dates rejected; changed date range keeps activities visible | pass |
| tests/app.e2e.js:431 | export, validated import, and HTML text escaping | pass |
| tests/app.e2e.js:468 | dark mode persists and dialogs support Escape and focus | pass |
| tests/app.e2e.js:490 | storage failure is visible and does not claim success | pass |
| tests/app.e2e.js:507 | responsive layouts do not overflow on common phone widths | pass |
| tests/app.e2e.js:554 | no requests go to original site or other external services | pass |
| tests/app.e2e.js:566 | corrupted stored data is preserved until explicitly replaced | pass |
| tests/app.e2e.js:599 | discard prompt preserves an unsaved dialog when declined | pass |
| tests/app.e2e.js:615 | another tab cannot silently overwrite an open edit draft | pass |
| tests/app.e2e.js:642 | section tabs are exactly the five remaining tabs numbered 01 to 05 | pass |
| tests/app.e2e.js:653 | trip menu button sits by the title, toggles expanded state and returns focus on close | pass |
| tests/app.e2e.js:687 | state saved before the change shows the same data in the trip menu and is not rewritten | pass |
| tests/assignment-motion.e2e.js:78 | shopping and gear selects persist with the same styling, without changing other item data | pass |
| tests/assignment-motion.e2e.js:118 | failed inline assignment preserves draft, disables further edits and does not falsely report saved | pass |
| tests/assignment-motion.e2e.js:143 | revision conflict keeps assignment as an unsaved draft instead of overwriting server data | pass |
| tests/assignment-motion.e2e.js:164 | only food and gear responsibility selects use person colors consistently in forms and across pages | pass |
| tests/assignment-motion.e2e.js:223 | demo assignment is offline-capable, handles untrusted names as text and preserves manual ingredient | pass |
| tests/assignment-motion.e2e.js:260 | hero moves automatically, pause lives in trip settings, is keyboard accessible and survives tab switches and reload without trip writes | pass |
| tests/assignment-motion.e2e.js:310 | reduced motion and print remain static, and card illustrations never animate | pass |
| tests/assignment-motion.e2e.js:354 | account forms stay neutral with jf open font, and footer motion preference fits 320px | pass |
| tests/assignment-motion.e2e.js:406 | person representative colors persist and follow every food and gear selector after editing | pass |
| tests/assignment-motion.e2e.js:472 | account recipe supports mixed ingredient separators and syncs after reload | pass |
| tests/avatar-preview.e2e.js:20 | account planner avatars use the first letter across tabs and reload without changing data | pass |
| tests/avatar-preview.e2e.js:63 | meal editor omits the image preview without changing saved data | pass |
| tests/brand.e2e.js:40 | public login and registration use the new brand | fail |
| tests/brand.e2e.js:55 | home, admin, trip, departure and invitation keep consistent branding without rewriting trip data | fail |
| tests/brand.e2e.js:80 | demo routes retain browser data and original-site attribution while changing the visible brand | fail |
| tests/brand.e2e.js:93 | new brand fits home and trip headers from phone to desktop in both themes | fail |
| tests/daily-life.e2e.js:42 | daily note stays stable across tabs and reload without changing trip data | pass |
| tests/daily-life.e2e.js:60 | Taipei midnight refreshes only the note and preserves an open meal draft | pass |
| tests/daily-life.e2e.js:94 | daily note fits mobile and dark mode and remains available offline in the demo | pass |
| tests/daily-life.e2e.js:120 | existing van moves without changing its artwork; pause, reduced motion and print stop it | pass |
| tests/expenses.e2e.js:47 | manual expense saves cents and chosen participants, shopping link never changes purchased status | pass |
| tests/expenses.e2e.js:75 | discarding an unsaved expense uses a styled prompt and preserves the draft when canceled | pass |
| tests/expenses.e2e.js:98 | invalid money and no participants never save; cancel and tab navigation preserve or discard only with confirmation | pass |
| tests/expenses.e2e.js:125 | stale ledger conflict retains form, explicit reload keeps draft, resubmission preserves other person entries | pass |
| tests/expenses.e2e.js:151 | lost success response retries the identical request and never books the money twice | pass |
| tests/expenses.e2e.js:187 | backend unavailable and demo mode fail closed instead of writing local money records | pass |
| tests/expenses.e2e.js:208 | repayment lowers outstanding balance, and owner removal recalculates totals after confirmation | fail |
| tests/expenses.e2e.js:241 | receipt text is re-parsed, every corrected item is explicitly reviewed, then duplicate photo is blocked | pass |
| tests/expenses.e2e.js:296 | desktop, mobile and dark theme expense view is readable without horizontal scroll | pass |
| tests/expenses.e2e.js:319 | receipt discrepancy and missing review confirmation block writes until corrected | pass |
| tests/gear-presets.e2e.js:31 | personal essentials fill a draft; cancellation and editing never auto-add | pass |
| tests/gear-presets.e2e.js:98 | tent can be shared and assigned; scope picker and grouped suggestions fit phone and dark mode | pass |
| tests/gear-presets.e2e.js:180 | account trip suggestions never touch server until saved and preserve existing gear | fail |
| tests/gear-presets.e2e.js:222 | native high contrast preset keeps keyboard focus while navigating | pass |
| tests/gear-presets.e2e.js:246 | existing shared gear becomes personal only on save, clearing assignee and ready | pass |
| tests/ingredients.e2e.js:41 | live preview has no storage effects; save syncs all categories and reload persists | pass |
| tests/ingredients.e2e.js:87 | shopping quantities can be edited in place and save on Enter or blur | pass |
| tests/ingredients.e2e.js:116 | new meal quantities can be filled from their placeholder without opening a dialog | pass |
| tests/ingredients.e2e.js:133 | cancelled and invalid meal drafts never alter shopping data | pass |
| tests/ingredients.e2e.js:161 | editing shared recipes and clearing ingredients removes only unused generated rows | pass |
| tests/ingredients.e2e.js:193 | manual details and purchased items survive deleting their recipe and later unchecking | pass |
| tests/ingredients.e2e.js:251 | duplicate manual items and linked deletions explain how to edit the existing ingredient | pass |
| tests/ingredients.e2e.js:286 | shopping rows can be removed with the matching close icon and confirmation | pass |
| tests/ingredients.e2e.js:314 | legacy storage migrates once to an isolated key, old-tab writes cannot overwrite it | pass |
| tests/ingredients.e2e.js:351 | old and new backups import with categorized ingredient metadata | pass |
| tests/ingredients.e2e.js:386 | offline sync persists and the mobile ingredient preview fits | pass |
| tests/ingredients.e2e.js:420 | untrusted ingredient names remain escaped in preview and shopping | pass |
| tests/invite-links.e2e.js:103 | owner and member lists show the right open links and a revoked link stops working | fail |
| tests/invite-links.e2e.js:174 | member at the 5-link limit sees the limit in the dialog, revokes one and creates again | fail |
| tests/invite-registration.e2e.js:75 | signed-out visitor sees the preview above the form, registers, lands on the trip; a second visitor gets the invalid-link page | fail |
| tests/invite-registration.e2e.js:150 | invite preview renders trip and inviter text without injecting markup | fail |
| tests/maps.e2e.js:24 | destination, activity and car links open encoded Google Maps without writing trip data or prefetching Google | pass |
| tests/maps.e2e.js:70 | untrusted location text is rendered only as escaped text on a fixed Google origin | pass |
| tests/meal-image-hidden.e2e.js:54 | meal editor hides artwork preview while cards retain inferred artwork | pass |
| tests/meal-image-hidden.e2e.js:101 | account edits preserve an explicitly saved image while legacy automatic meals stay automatic | fail |
| tests/meal-image-hidden.e2e.js:144 | account template still updates hidden artwork but cancelling never changes saved data | fail |
| tests/meal-layout.e2e.js:52 | account menu groups by date then meal time without writing or reordering stored data | pass |
| tests/meal-layout.e2e.js:71 | five-slot dropdown saves and moves a card immediately, preserving other meal fields and shopping | fail |
| tests/meal-layout.e2e.js:118 | small cards are readable at phone/tablet/desktop sizes in light and dark mode | pass |
| tests/meal-layout.e2e.js:144 | legacy custom slot remains selected and survives unrelated edits; new meal uses five choices | pass |
| tests/meal-layout.e2e.js:180 | refined selectors keep compact matching person colors, focus, and neutral meal fields | pass |
| tests/mobile-swipe.e2e.js:708 | a tracked touch drag writes its offset to the inline --swipe-x | pass |
| tests/mobile-swipe.e2e.js:726 | a 40px drag moves only the surface, 1:1 with the finger and with no transition | pass |
| tests/mobile-swipe.e2e.js:749 | the action panel turns visible at the first leftward pixel, before release | pass |
| tests/mobile-swipe.e2e.js:766 | dragging one row closes the row that was open | pass |
| tests/mobile-swipe.e2e.js:800 | the action panel shows exactly the strip the dragged surface has uncovered | pass |
| tests/mobile-swipe.e2e.js:845 | a fast 20px leftward flick opens the row | pass |
| tests/mobile-swipe.e2e.js:863 | after a drag past 100px, a fast rightward flick closes the row though it ends past halfway | pass |
| tests/mobile-swipe.e2e.js:885 | a slow release settles closed short of halfway and open past it | pass |
| tests/mobile-swipe.e2e.js:909 | opening and closing settles share one transition-duration of at most 320ms | pass |
| tests/mobile-swipe.e2e.js:942 | past the End_Stop the surface moves 0.3 times the overshoot, at most 48px, and a release there opens the row | pass |
| tests/mobile-swipe.e2e.js:977 | a closed row dragged rightward holds at 0 | pass |
| tests/mobile-swipe.e2e.js:998 | an open row dragged rightward tracks back to 0 and holds there | pass |
| tests/mobile-swipe.e2e.js:1034 | a mostly vertical touch drag scrolls the page and never tracks the row | pass |
| tests/mobile-swipe.e2e.js:1078 | a mostly horizontal touch drag tracks the row and leaves the page where it was | pass |
| tests/mobile-swipe.e2e.js:1110 | a pointercancel settles a closed row back to closed and clears its inline --swipe-x | pass |
| tests/mobile-swipe.e2e.js:1134 | a pointercancel settles an open row back to open and clears its inline --swipe-x | pass |
| tests/mobile-swipe.e2e.js:1168 | leaving the touch layout mid-drag closes every row, clears every inline --swipe-x and abandons the gesture | pass |
| tests/mobile-swipe.e2e.js:1216 | under reduced motion a drag tracks 1:1, holds at the End_Stop and settles with no animation | pass |
| tests/mobile-swipe.e2e.js:1280 | a reduced-motion preference change applies to the next gesture with no reload | pass |
| tests/mobile-swipe.e2e.js:1510 | a prepared row clones its enabled actions into the panel with the swipe-action conventions | pass |
| tests/mobile-swipe.e2e.js:1537 | every row a re-render adds gets one panel and one toggle, and a re-inserted row gets no second panel | pass |
| tests/mobile-swipe.e2e.js:1595 | a toggle click closes the other rows and inverts the state of its own row | pass |
| tests/mobile-swipe.e2e.js:1618 | a click outside every panel closes the open row | pass |
| tests/mobile-swipe.e2e.js:1634 | a swipe of at least 42px swallows the next click within 450ms and only that one | pass |
| tests/mobile-swipe.e2e.js:1670 | a tap with no travel swallows no click | pass |
| tests/mobile-swipe.e2e.js:1700 | a row whose allowlisted actions are all disabled gets no panel and no toggle | pass |
| tests/mobile-swipe.e2e.js:1788 | a fast 40px drag released after a 200ms pause settles closed | pass |
| tests/mobile-swipe.e2e.js:1798 | a fast 100px drag released after a 200ms pause settles open | pass |
| tests/ocr-assets.e2e.js:5 | OCR assets are same-origin and on demand, CSP allows only WASM evaluation, photos have no public upload route | pass |
| tests/picker.e2e.js:41 | meal and shopping headings match the slogan without data writes | pass |
| tests/picker.e2e.js:52 | pointer selection saves; Escape and outside dismissal leave data untouched | pass |
| tests/picker.e2e.js:86 | keyboard selection saves; Escape only closes the picker inside an edit dialog | fail |
| tests/picker.e2e.js:122 | high contrast keeps the native select usable | pass |
| tests/picker.e2e.js:136 | opened pickers fit phone and desktop in both themes with matching person dots | pass |
| tests/picker.e2e.js:187 | all form dropdowns share the same picker appearance | pass |
| tests/receipt-ocr.e2e.js:43 | selecting a receipt automatically sends it to GPT-6 Luna and displays editable candidates | fail |
| tests/receipt-ocr.e2e.js:87 | OpenAI failure stops recognition without local OCR or automatic retry | pass |
| tests/recipes-invites.e2e.js:17 | recipe presets preview, merge shortcuts and save correct picture plus shopping | pass |
| tests/recipes-invites.e2e.js:65 | template replacement asks, preserves custom ingredients and can be cancelled entirely | pass |
| tests/recipes-invites.e2e.js:107 | existing meals retain automatic or explicitly saved images while the image selector is hidden | pass |
| tests/recipes-invites.e2e.js:146 | invitation button leads to self-entry and duplicate names cannot take over identities | pass |
| tests/recipes-invites.e2e.js:187 | invitation draft survives theme, offline and cross-tab rerender | pass |
| tests/recipes-invites.e2e.js:223 | signup failure never claims permanent save and untrusted name is text | pass |
| tests/recipes-invites.e2e.js:241 | readable typography, template panels and invite fit phone and desktop | pass |
| tests/recipes-invites.e2e.js:275 | offline preset editing and locally hosted font continue to work after reload | pass |
| tests/schedule-bar.e2e.js:134 | 新增一站 stays to the right of the date tabs and no date button is squeezed, at every width for 3, 8 and 15 days | pass |
| tests/trip-deletion.e2e.js:57 | home omits legacy and local notices without changing saved demo data | pass |
| tests/trip-deletion.e2e.js:83 | admin can cancel then confirm own trip deletion from home on phone and desktop (1.0m) | fail |
| tests/trip-deletion.e2e.js:140 | admin deletes another owner trip in backend, revokes link and leaves other trips and account intact | fail |
| tests/trip-deletion.e2e.js:189 | stale revision and failed deletion keep card and show error instead of success | pass |
| tests/trip-deletion.e2e.js:234 | home hides the JSON import entry but retains validated import for future use | pass |
| tests/vehicle-departures.e2e.js:52 | separate starts show sorted first-day cars and leave the shared schedule and data unchanged | pass |
| tests/vehicle-departures.e2e.js:77 | editing in the schedule syncs to the trip menu and reload; editing in the trip menu syncs back | pass |
| tests/vehicle-departures.e2e.js:127 | empty fleet can add cars directly without creating duplicate activities, validates seats and location | pass |
| tests/vehicle-departures.e2e.js:193 | free-form legacy meeting text is not guessed or overwritten on unrelated edits | pass |
| tests/vehicle-departures.e2e.js:212 | unsaved vehicle drafts and stale saves never overwrite the newer server plan | pass |
| tests/vehicle-departures.e2e.js:245 | collaborators can edit departures but cannot delete cars; strangers cannot read the trip | fail |
| tests/vehicle-departures.e2e.js:298 | cards fit mobile and desktop, long or untrusted text stays safe, print retains departure plans | pass |
| tests/vehicle-departures.e2e.js:349 | demo can save departure changes and reload them offline | pass |
| tests/vehicle-departures.e2e.js:375 | empty and time-only legacy locations can keep their data on an unrelated vehicle edit | pass |
| tests/vehicle-departures.e2e.js:393 | owner removal from the schedule also removes the same car from the trip menu without touching activities | pass |
| tests/vehicle-itinerary.e2e.js:91 | cars split shopping and pickup through separate arrivals; shared stops and next-stop stay accurate | pass |
| tests/vehicle-itinerary.e2e.js:130 | legacy people stay exact on unrelated edits and may explicitly switch to one car, multiple cars, then all | pass |
| tests/vehicle-itinerary.e2e.js:157 | empty vehicle selection and cancelled draft do not save; referenced car cannot be deleted | pass |
| tests/vehicle-itinerary.e2e.js:212 | new stop respects selected car and day, draft survives conflict without overwriting the other assignment | pass |
| tests/vehicle-itinerary.e2e.js:250 | no vehicles disables car choice | pass |
| tests/vehicle-itinerary.e2e.js:267 | one car can have a specific stop without changing it to everyone | pass |
| tests/vehicle-itinerary.e2e.js:290 | countdown remains SVG-centered across breakpoints and themes, illustration animation remains outside badge | pass |
| tests/vehicle-itinerary.e2e.js:334 | mobile vehicle choices wrap untrusted names and remain keyboard accessible with print labels | pass |
| tests/vehicle-itinerary.e2e.js:368 | demo assignment survives reload offline and legacy backups remain usable | pass |

## Operator actions

The agent cannot perform these actions. Each one names its Findings and the risk that remains until it is done.

### 1. Key revocation and rotation

Related Findings: SR-18, SR-61. Remaining risk until done: if a key was ever committed or shared, anyone who copied it can spend on your OpenAI account.

The scanned files contain no key. Do these steps if the history scan (action 2) reports an OpenAI key, or if you suspect a key was exposed:

1. In the OpenAI dashboard, open the project's API keys and revoke the exposed key. The agent did not revoke, rotate, or test any key.
2. Create a new key for the same project.
3. On the server, write only the new key to the key file named by `CAMPING_OPENAI_API_KEY_FILE` (default `.secrets/openai_api_key`; in Docker, the file mounted at `/run/secrets/openai_api_key`). Leave `CAMPING_OPENAI_API_KEY` unset.
4. Restart the App_Server. The key is read once at startup (SR-61).
5. Open the Admin_Page and check that receipt AI is enabled, then recognize one receipt.
6. Check the OpenAI usage page for requests you did not make while the old key was valid.

### 2. Git history scan and rewrite

Related Findings: SR-18. Remaining risk until done: whether any commit holds a key or the `.secrets/openai_api_key` file is unknown.

1. In a terminal with git and Bun, run `git clone --mirror <your-repository-url> repo.git`, then from this project folder run `bun scripts/scan-secrets.mjs --root repo.git`. Alternatively, run `bun scripts/scan-secrets.mjs` inside an ordinary clone.
2. If the scan exits 0, record the HEAD commit ID it scanned. No rotation is needed.
3. If it reports a history Secret_Finding, first revoke the key (action 1). Rewriting history does not replace revocation, because existing clones and forks keep the old commits.
4. Remove the file or value from history with `git filter-repo` (for example, `git filter-repo --invert-paths --path .secrets/openai_api_key`, or `--replace-text` for a value inside a tracked file). Use the commit IDs from the scan output to confirm each affected commit is rewritten.
5. Force-push the rewritten branches and tags yourself, ask every collaborator to re-clone, and ask the hosting provider to purge cached views if the repository was public. The agent did not rewrite history or push.
6. Run the scan again on a fresh mirror and confirm it exits 0.

### 3. OpenAI budget and usage limits

Related Findings: SR-02. Remaining risk until done: the app caps usage at 1000 requests a month (about USD 3.40 at the prices above), but a stolen key used outside the app has no cap.

1. In the OpenAI dashboard, open the project used by this app.
2. Set a monthly budget, for example USD 5, and an email alert at a lower amount.
3. Set the project's usage limits or allowed models so that the project can call only `gpt-6-luna`, if the dashboard offers that.
4. Use a separate project for this app, so that its key and budget are isolated from other work.

### 4. nginx deployment

Related Findings: SR-15, SR-42, SR-47. Remaining risk until done: none of the nginx protections (HTTPS redirect, HSTS, body limit, dot-path rule) apply to a deployment that does not use the example config.

1. Follow [docs/deploy-nginx.md](deploy-nginx.md) "Deployment steps" 1 to 6. Keep the App_Server on `127.0.0.1:5173` with `CAMPING_PUBLISHED=1` and `CAMPING_PUBLIC_ORIGIN=https://www.our-littlemoments.com`.
2. Copy the example `server` blocks unchanged, including `location ~ /\.(?!well-known/) { return 404; }` before `location /`, then run `sudo nginx -t` and reload nginx.
3. Run the checks in step 6 of the guide (HSTS header, redirects, unknown Host, 404 for `/demo/` and `/setup`, 403 for public registration, app port closed from another machine).
4. For SR-47, restrict who can read `/var/log/nginx/`, keep log retention short (for example 14 days through logrotate), or use a `log_format` that does not record invite paths.
5. Create the first administrator with `bun run create-admin` on the server before you share any link.

### 5. TLS certificates

Related Findings: SR-42. Remaining risk until done: without valid certificates, browsers refuse the site or users learn to click through warnings, and the `Secure` cookie and HSTS give no protection.

1. Point the DNS records for `our-littlemoments.com` and `www.our-littlemoments.com` at the server.
2. Run `sudo certbot certonly --nginx -d our-littlemoments.com -d www.our-littlemoments.com`, as described in [docs/deploy-nginx.md, Certificates](deploy-nginx.md#certificates).
3. Check that `ssl_certificate` and `ssl_certificate_key` in both TLS blocks point at `/etc/letsencrypt/live/our-littlemoments.com/`.
4. Run `sudo certbot renew --dry-run` and confirm that renewal reloads nginx.
5. Read the guide's HSTS section before sending HSTS. Browsers keep the `max-age=15552000` policy for 180 days.

## Remaining risks

Every Finding whose status is not Fixed or Already Mitigated, plus the open test items.

| Finding | Severity | Status | Reason |
| --- | --- | --- | --- |
| SR-18 | Medium | Operator Action | Git history was not scanned here; see operator action 2. |
| SR-44 | Medium | Deferred | Filling the Rate_Limiter with about 10,000 keys can clear a username lockout. Fix it before publishing. |
| SR-45 | Medium | Accepted Risk | Docker local-only setup trusts a loopback Host header; create the admin before allowing LAN access. |
| SR-46 | Low | Deferred | The safe error log line keeps the full path, which can include an invite token. |
| SR-47 | Low | Operator Action | nginx access logs record invite URLs; see operator action 4. |
| SR-48 | Low | Accepted Risk | Registration says when a username is taken; registration needs an invite in Published_Mode. |
| SR-49 | Low | Accepted Risk | `style-src 'unsafe-inline'` is needed by the SVG art; no script can run from it. |
| SR-50 | Low | Accepted Risk | Login and registration limits are in memory and reset on restart. |
| SR-51 | Info | Accepted Risk | Before the first Admin exists, a body-less register request gets 409 before 415 (kept for PBN tests). |
| SR-52 | Info | Accepted Risk | Rejected logins write a Failed_Login_Event by design, despite the "4xx changes nothing" rule. |
| SR-53 | Info | Accepted Risk | A malformed percent-encoded path gets 400 before the session check; no data is returned. |
| SR-54 | Info | Deferred | `scripts/check-accounts.mjs` imports `playwright`, which `package.json` does not declare. |
| SR-55 | Info | Deferred | Stale `.tmp-e2e-dist/` and `tmp-menu-check/` directories are not ignored by git or Docker. |
| SR-56 | Info | Deferred | 8 PBN-set e2e tests fail as in the baseline (UI copy, a timeout, and the shared `register` limit). |
| SR-57 | Info | Deferred | No automated test covers the failed-session-check page (SR-41). |
| SR-58 | Info | Accepted Risk | The image sets `CAMPING_OPENAI_API_KEY_FILE` to the fixed Docker secret path. |
| SR-59 | Info | Accepted Risk | A server-validated username and UUID reach `href` without `e()`. |
| SR-60 | Info | Accepted Risk | No second factor and no breached-password check. |
| SR-61 | Info | Accepted Risk | A new OpenAI key needs an App_Server restart. |

Open test and verification items:

| Item | Reason |
| --- | --- |
| Before-fix test results | Fixed-Finding tests were not run against the pre-fix code; the "Before" column above is the expected result (Requirement 25.1, 25.2). |
| Control-removal check for Already Mitigated tests | No control was removed to show that its test fails without it (Requirement 25.3). |
| Full e2e run | The other 17 e2e files were not rerun after the changes; the baseline full run already had 18 failures, 7 of them from the shared `register` limit. |
| E2E PBN-set failures | Same 8 failures as the baseline (SR-56). |
| Image token count for `gpt-6-luna` | The OpenAI vision guide has no row for this model; the cost estimate uses the `gpt-6-astra` rule as an assumption. |
