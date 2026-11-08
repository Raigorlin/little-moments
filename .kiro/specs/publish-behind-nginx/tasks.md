# Implementation Plan: Publish Behind nginx

## Overview

Implementation is in JavaScript (ES modules on Bun, `bun test` for unit and property tests, Playwright through `scripts/check-accounts.mjs` for e2e). The work starts with the pure `server/deploy-config.js` module and its property tests. It then wires the request context into `server/http.js` and `server/accounts.js`, which also makes the failing hostname test in `tests/http.test.js` pass. Next come the invitation changes (member inviters, single-use links, public preview, invite registration, invite ids, the open-link list, and revoke by id), the first-admin CLI and startup, the receipt AI policy, the client pages, the service worker, and the deployment guide. Every task changes code, tests, or repository documentation only. Nothing is deployed and the operator's server is not touched.

Checkpoint commands (PowerShell does not expand `tests/*.test.js`, so pass the directory):

- Unit and property tests: `bun test tests`
- E2E: `bun run build`, then `$env:CAMPING_BUN = (Get-Command bun).Source; node scripts/check-accounts.mjs <files>` (set `CHROME_PATH` if Chrome is not at the default path)

## Tasks

- [x] 1. Add the pure deployment configuration module
  - [x] 1.1 Create `server/deploy-config.js`
    - Export `ConfigError`, `ENV`, `parseDeploymentConfig`, `LOCAL_DEFAULTS`, `resolveDbPath`, `normalizeIp`, `isLoopbackAddress`, `isIpLiteralHost`, `hasForwardingHeaders`, `selectClientAddress`, `isHostAllowed`, `resolveRequestContext`, and `formatStartupLines` as specified in the design
    - Boolean_Setting parsing, Public_Origin shape rules, `HOST` opt-in, Docker/published conflict, trusted proxies, extra hosts, policy values, and a frozen result
    - `CAMPING_REGISTRATION`: `open` with `CAMPING_PUBLISHED=1` throws `ConfigError` naming the variable; published unset or `closed` gives `closed`; Local_Mode default `open`
    - No I/O and no database access, so the module loads in tests without a server
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.3, 4.4, 4.5, 5.1, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 10.4, 10.5_

  - [x] 1.2 Add `fast-check` and example tests in `tests/deploy-config.test.js`
    - Add `fast-check` to `devDependencies` in `package.json`
    - Valid Published_Mode config for `https://www.our-littlemoments.com`; `parseDeploymentConfig({})` equals `LOCAL_DEFAULTS`
    - One example per rejection in Requirement 2, including missing origin, published with Docker, published with extra hosts, and `CAMPING_REGISTRATION=open` with `CAMPING_PUBLISHED=1`
    - Address examples: trusted peer, untrusted peer with spoofed headers, multi-entry `X-Forwarded-For`, invalid selected entry
    - `formatStartupLines` content, with no key text when `CAMPING_OPENAI_API_KEY` is set
    - _Requirements: 1.2, 1.4, 1.5, 13.2, 13.3, 13.18_

  - [x] 1.3 Write property tests for client address selection
    - **Property 1: Client address follows the trusted-proxy selection rule**
    - **Property 2: Prepended forwarding entries cannot change the client address**
    - **Property 3: IPv4 and IPv4-mapped IPv6 are the same address**
    - One `fc.assert` per property, at least 100 runs, tagged `// Feature: publish-behind-nginx, Property N: …`
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  - [x] 1.4 Write property tests for host and origin decisions
    - **Property 4: Host allowlist matches the mode model** (against `isHostAllowed` and `resolveRequestContext`)
    - **Property 5: Expected origin and cookie security depend only on mode and proxy status**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.3, 4.4, 5.1, 5.3, 6.6**

  - [x] 1.5 Write property tests for configuration parsing
    - **Property 7: Invalid setting values stop startup with a named error** (generator includes published + `CAMPING_REGISTRATION=open`)
    - **Property 8: Configuration normalization is idempotent** (asserts `registrationPolicy === 'closed'` for every valid published config)
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 4.5, 10.4**

- [x] 2. Wire the request context into the HTTP handler and account service
  - [x] 2.1 Update `server/http.js`
    - `createHttpHandler({ root, accounts, config = LOCAL_DEFAULTS })` calls `resolveRequestContext` before `accounts.handle`
    - 403 `Forbidden host` and 400 `Bad forwarding header` with `SECURITY_HEADERS`, before the account service and static handling
    - In Published_Mode: `/demo`, `/demo/`, `/setup`, `/setup/` return 404; `shellResponse` injects `<meta name="camping-deployment" content="published">`; `swResponse` replaces `const PUBLISHED=false;` with `const PUBLISHED=true;`; both keep `SECURITY_HEADERS` (including `Cache-Control: no-store` for the shell and `Referrer-Policy: no-referrer`)
    - Local_Mode responses stay as today
    - _Requirements: 3.1, 3.2, 3.8, 6.4, 8.1, 9.1, 9.4, 9.5, 9.6, 15.6_

  - [x] 2.2 Update `server/accounts.js` for the request context and registration lock
    - Export `HttpError`, `RateLimiter`, `validateUsername`, `validateDisplayName`, `validatePassword`
    - Add the `deployment` option; `handle` uses `info.expectedOrigin`, `info.secureCookie`, and `info.clientAddress` with today's fallbacks; `cookieHeader(secure, token, maxAge)`; `startSession(request, info, user, extra)`
    - Add `/api/setup` to the route table only when `deployment.published` is false
    - `routes.register`: `closed` → 403 `目前不開放公開註冊，請使用旅行邀請連結建立帳號。` before the `register` limiter and before reading the body
    - `routes.getSession` returns `webSetup`, `registrationOpen`, and `inviteRegistration`
    - _Requirements: 1.2, 1.3, 4.1, 4.2, 5.1, 5.2, 5.3, 7.1, 7.4, 8.2, 8.5, 10.1, 10.2, 10.4, 10.5, 10.6, 10.7_

  - [x] 2.3 Make the hostname test in `tests/http.test.js` pass and add host cases
    - Run "unexpected hostname rejected even if DNS points to localhost" unchanged and confirm it now returns 403
    - Add: `http://192.168.1.10:5182/` accepted in Local_Mode; the Apex_Hostname rejected in Published_Mode; a rejected host never reaches a stub account service
    - _Requirements: 3.1, 3.6, 13.1, 13.4_

  - [x] 2.4 Create `tests/publish.test.js` with Published_Mode examples
    - Proxied login with `Origin: https://www.our-littlemoments.com` succeeds and `Set-Cookie` has `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age`
    - `/setup` and `POST /api/setup` → 404 in Published_Mode for proxied and direct-local requests and for a bad Origin
    - `/demo/` → 404 published, 200 local; `/app.js` and a chunk → 200 published; meta tag and `const PUBLISHED=true;` only in Published_Mode from the same `dist`
    - Registration policy `open` → 200, `closed` → 403; Published_Mode `POST /api/register` → 403 for a valid body, a malformed body, and no body, without consuming the `register` bucket; session flags per mode
    - Two proxied failed logins with different `X-Forwarded-For` use separate `loginClient` buckets
    - _Requirements: 5.2, 8.1, 8.2, 9.1, 9.4, 9.6, 10.2, 10.6, 10.7, 13.5, 13.6, 13.8, 13.9, 13.12_

  - [x] 2.5 Write property tests for the origin check and rate-limit isolation
    - **Property 6: Mutating requests pass the origin check exactly when Origin equals the expected origin**
    - **Property 9: Rate-limit buckets are isolated per client address** (limits `loginClient`, `register`, `invitePreview`)
    - **Validates: Requirements 4.1, 4.2, 4.5, 7.1, 7.2, 7.3, 15.4**

- [x] 3. Checkpoint - Ensure all tests pass
  - Run `bun test tests`. Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the invitation changes
  - [x] 4.1 Add invite usage and id columns and the migration in `server/accounts.js`
    - Add `used_at INTEGER`, `used_by TEXT REFERENCES users(id)`, and `id TEXT NOT NULL` to the `invites` table in `SCHEMA`
    - Add `migrateInviteColumns(db)` per the design (`PRAGMA table_info` / `PRAGMA index_list`, `ALTER TABLE invites ADD COLUMN …` for each missing column, backfill every row with `id IS NULL` with `randomUUID()`, `CREATE UNIQUE INDEX IF NOT EXISTS invites_id ON invites(id)`, all in `BEGIN IMMEDIATE`, rollback on error) and call it after `migrateCoverKinds(db)`
    - The unique index is created in the migration, not in `SCHEMA`, so old databases do not fail before the column exists
    - _Requirements: 17.7, 19.9_

  - [x] 4.2 Let trip members invite, with active-invite limits
    - `capabilities`: `canInvite: manage || isMember`; add `requireInviter`; remove `requireManager`
    - `createInvite`: trip limit 20 and new `MAX_MEMBER_INVITES = 5` for creators who are not Trip_Managers (409 `每位旅伴在每趟旅行最多 5 個有效邀請連結。`); `activeInvites` and new `activeInvitesByUser` exclude used, revoked, and expired invites
    - `insertInvite` takes a new `randomUUID()` `id`; the 201 response becomes `{ id, token, urlPath, expiresAt }`
    - Replace `inviteByHash` with `inviteForUse`, which also requires the creator to be the owner, an admin, or a Trip_Member
    - Add `revokeCreatorTripInvites(tripId, userId)` for any future membership-removal path; in `adminPatchUser`, an admin → member change runs `revokeInvitesWithoutRights` in the same transaction; account deletion keeps `revokeInvitesBy`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 19.8_

  - [x] 4.3 Make invitation links single-use for signed-in joins
    - Add `resolveInvite`, `inTrip`, `usableInvite`, and `consumeInTx` with the `consumeInvite` query (`used_at IS NULL AND revoked_at IS NULL` guard, `changes !== 1` → 404)
    - Extract `addMemberInTx` from `joinInvite`
    - `joinInvite`: accounts already in the trip get `{ tripId }` without consumption; a used link → 404 for others; membership insert and consumption in one `tx`
    - `getInvite`: `alreadyMember: true` for accounts in the trip even on a used link; used link → 404 for others; response shape unchanged
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

  - [x] 4.4 Add the invitation preview and the revoke-by-id route
    - `LIMITS.invitePreview = { max: 60, window: 15 * 60000 }`
    - `GET /api/invites/<token>/preview`: count and check `invite-preview:<Client_Address>` before the lookup (429 `查看邀請的次數太多，請稍後再試。`); `usableInvite`; respond with exactly `title, destination, startDate, endDate, inviterName`; no session read and no write
    - `POST /api/trips/<tripId>/invites/<inviteId>/revoke`: `requireUser`, `readJson`, then in `tx` `requireExpectedUser`, `requireInviter(tripAccess(...))` (404 `找不到這趟旅行。`), `ID.test(inviteId)` + `activeInviteById` (404 `邀請連結無效或已過期。`), creator or `access.canManage` check (403 `只有建立連結的人、主辦人或管理員可以撤銷邀請。`), `revokeInviteById`, audit `invite.revoke`; respond `{ revoked: true }`
    - Do not add a token-based `/api/invites/<token>/revoke` route
    - Add both entries to the route table
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.7, 15.8, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_

  - [x] 4.5 Add invite registration
    - `POST /api/invites/<token>/register` per the design: shared `register` limiter keyed on Client_Address, `needsSetup` 409, shared validators, `usableInvite` before hashing, re-check inside `tx`, `insertUser`, `addMemberInTx`, `consumeInTx`, audits `register.invite` and `invite.join`, then `startSession(…, { tripId })`
    - Works under both Registration_Policy values
    - _Requirements: 10.7, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.14_

  - [x] 4.6 Update existing tests that encode the old invitation rules in `tests/accounts.test.js`
    - "members can edit and patch but not invite" → expect `canInvite: true` and 201 from invite creation; rename to "members can edit, patch and invite"
    - `MEMBER` constant → `canInvite: true`; in "list and envelope expose capabilities; forged permission fields are ignored", the forged-body member invite returns 201 and `permissions` still ignore forged fields
    - "deleting a member of a full 100-person trip keeps the trip valid": the 101st account uses a new owner link, so the 409 still comes from the full trip
    - Leave the idempotent-join and 7-day/20-link tests unchanged and confirm they pass
    - _Requirements: 13.13, 13.19_

  - [x] 4.7 Create `tests/invites.test.js` with example tests
    - Preview: exact fields, headers through `createHttpHandler`, 61st request → 429 while another Client_Address gets 200, preview does not consume, `GET /api/invites/<token>` without session → 401
    - Inviters: capability table (owner, Trip_Member, admin outside the trip, outsider); member creates a link with audit; 6th member link → 409 while the owner can still create; account deletion and admin demotion revoke links; a demoted admin's old link previews as 404
    - Single use: second account 404 after Invite_Join and after Invite_Registration; owner opening a used link gets `alreadyMember: true`; failed join leaves `used_at` NULL; two concurrent joins add one member; same rules in Published_Mode
    - Migration: old `invites` schema fixture upgrades in place with rows kept and the old link usable once
    - Revoke by id: create response has a UUID `id` different from `token` and `sha256(token)`; creator, owner, admin 200 with `invite.revoke`; other Trip_Member 403; malformed, unknown, other-trip, used, expired, revoked id 404 `邀請連結無效或已過期。`; account outside the trip 404 `找不到這趟旅行。`; no session 401; foreign Origin 403; revoked link previews as 404; `POST /api/invites/<token>/revoke` 404 `找不到這個 API。`
    - _Requirements: 13.14, 13.15, 13.16, 13.17, 15.6, 15.8, 16.2, 16.8, 16.9, 17.5, 17.6, 17.7, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_

  - [x] 4.8 Write property tests for the preview
    - **Property 12: The invitation preview returns exactly the public fields**
    - **Property 13: Unusable invitation links are indistinguishable** (token states prepared once in `beforeAll`)
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.7, 17.3**

  - [x] 4.9 Write property test for single-use links
    - **Property 14: An invitation link adds at most one account**
    - At most four accounts per run to bound scrypt cost
    - **Validates: Requirements 14.2, 17.1, 17.2, 17.3, 17.4**

  - [x] 4.10 Write property test for invite limits
    - **Property 15: Invite creation follows the active-invite limits** (reference model over create, consume, revoke, and clock advance)
    - **Validates: Requirements 16.4, 16.5, 16.6**

  - [x] 4.11 Add invite registration tests to `tests/publish.test.js`
    - Success with cookie, membership, and audits; works under `closed`; invalid, expired, and used token → 404; taken username → 409; name conflict → 409 with no new user and the link unused; shared `register` limit per Client_Address; bad Origin → 403; no users → 409
    - **Property 11: Invite registration is atomic** (also asserts `used_by`)
    - **Validates: Requirements 13.10, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12**

  - [x] 4.12 Add the invite list route to `server/accounts.js`
    - `listTripInvites` and `listTripInvitesBy` queries per the design (select only `id`, creator `display_name`, `created_at`, `expires_at`; exclude used, revoked, expired; newest first)
    - `routes.listInvites`: `requireUser` (401), `requireInviter(tripAccess(...))` (404 `找不到這趟旅行。`), all Active_Invites when `access.canManage`, else only the caller's own; respond `{ invites: [{ id, creatorName, createdAt, expiresAt }] }` through an explicit field map
    - Add `GET: routes.listInvites` to the existing `/^\/api\/trips\/([^/]+)\/invites$/` entry
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7_

  - [x] 4.13 Create `tests/invite-list.test.js` with example tests
    - Scope: owner and admin outside the trip see every Active_Invite; a Trip_Member sees only their own; outsider 404 `找不到這趟旅行。`; no session 401; no `Origin` header needed
    - No secrets: serialized body contains no token, no `sha256(token)`, no user ID, no username; entry keys exactly `id, creatorName, createdAt, expiresAt`
    - Exclusion of used, expired, and revoked invites; newest-first order
    - Migration: pre-feature `invites` fixture with three rows (no `used_at`, `used_by`, `id`) gets distinct non-null UUID ids, keeps other values, has the `invites_id` unique index (duplicate insert fails), keeps the same ids on reopen, and the old links list and revoke by id
    - _Requirements: 13.20, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.9_

  - [x] 4.14 Write property tests for the invite list and revoke by id in `tests/invite-list.test.js`
    - **Property 16: The invite list shows exactly the revocable Active_Invites and never exposes tokens**
    - **Property 17: Revoke by id follows the creator-or-manager rule**
    - Accounts and trips created once in `beforeAll`; one `fc.assert` per property, at least 100 runs, tagged `// Feature: publish-behind-nginx, Property N: …`
    - **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 19.1, 19.2, 19.3, 19.4, 19.5, 19.8**

- [x] 5. Checkpoint - Ensure all tests pass
  - Run `bun test tests`. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Add the first-admin CLI and published startup
  - [x] 6.1 Add `createFirstAdmin` and `needsSetup` to the account service
    - `createFirstAdmin(input, { auditAction })` validates with the shared validators, hashes, and inserts in `tx` with the user-count check (409 `管理員已設定完成。`)
    - `routes.setup` keeps its loopback check and calls `createFirstAdmin`
    - _Requirements: 8.5, 8.13, 8.14_

  - [x] 6.2 Update `scripts/serve.mjs`
    - Parse with `parseDeploymentConfig(process.env)`; on `ConfigError` print `Configuration error: <message>` and exit 1
    - Pass `config` to `Bun.serve`, `createHttpHandler`, and `createAccountService({ deployment: config, allowLoopbackHostFromContainer: config.dockerLocalOnly })`
    - Keep the Local_Mode log lines; print the Published_Mode lines from `formatStartupLines`, and the `bun run create-admin` hint when `needsSetup()`
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.12, 8.3_

  - [x] 6.3 Create `scripts/create-admin.mjs` and the `create-admin` script
    - `runCreateAdmin({ argv, env, projectRoot, isTTY, prompt, promptHidden, out, err, openService })` per the design; `askHidden` with raw mode, backspace, Ctrl+C (exit 130), Ctrl+D
    - Add `"create-admin": "bun scripts/create-admin.mjs"` to `package.json`
    - _Requirements: 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 8.16_

  - [x] 6.4 Create `tests/create-admin.test.js`
    - Success with audit `setup.cli` and no password in output or audit; refusal when a user exists; validation retry; password mismatch; `['--password', 'x']` → exit 2 without prompting; `isTTY: false` → exit 1; `CAMPING_ADMIN_PASSWORD` ignored; concurrent `createFirstAdmin` → one 409; `askHidden` with a fake stream
    - _Requirements: 8.7, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 8.16, 13.7_

- [x] 7. Add the receipt AI policy
  - [x] 7.1 Create `server/settings.js`
    - `RECEIPT_AI_POLICIES`, `RECEIPT_AI_KEY`, `resolveReceiptAiPolicy(stored, seed)` (invalid stored value → `off`), `receiptAiDecision({ policy, role, canEdit, keyEnabled })`
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6, 11.7_

  - [x] 7.2 Create `tests/settings.test.js`
    - Exhaustive stored × seed table for `resolveReceiptAiPolicy`
    - **Property 10: Receipt AI decision follows the policy table**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7**

  - [x] 7.3 Add the settings store and admin settings routes to `server/accounts.js`
    - `settings` table in `SCHEMA`, `settingByKey` and `upsertSetting` queries, `receiptAiPolicy()` service method
    - `GET`/`PATCH /api/admin/settings` with `requireAdmin`, 400 for invalid values, audit `settings.receipt-ai`
    - `getReceiptAi` and `recognizeReceiptAi` apply `receiptAiDecision` (`disabledReason`, 403 `admins-only`, 503 `off`); existing per-user, daily, and concurrency limits unchanged
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.12, 11.13_

  - [x] 7.4 Add receipt AI policy tests to `tests/publish.test.js`
    - Each policy through status and recognition with a fake `receiptAi`; seed applies when nothing is stored; admin PATCH applies without restart and writes the audit entry; member PATCH → 403; invalid value → 400; a file-backed database keeps the stored value across service instances
    - _Requirements: 11.8, 11.9, 11.10, 11.12, 13.11_

- [x] 8. Checkpoint - Ensure all tests pass
  - Run `bun test tests`. Ensure all tests pass, ask the user if questions arise.

- [x] 9. Update the client
  - [x] 9.1 Gate the Local_Planner in `src/entry.js`
    - Read the `camping-deployment` meta tag; start `app.js` for `/demo` paths only when not published
    - _Requirements: 9.2, 9.5_

  - [x] 9.2 Update session-driven pages and the invite page in `src/accounts-ui.js`
    - `/demo` shortcut checks `!published`; not-set-up page when `needsSetup && !webSetup`; closed register page and login link text when `!registrationOpen`
    - Signed-out `renderInvite`: call `GET /api/invites/<token>/preview`; 404 → invalid-link page with `前往登入`; 429 → retry message; 200 → preview summary (title, dates, destination, `<inviterName> 邀請你加入`, all through `e()`) above the registration form with the single-use note; submit to `POST /api/invites/<token>/register` and open the trip
    - Signed-in `renderInvite`: a 404 for a used link shows the invalid-link page; `alreadyMember` view unchanged
    - _Requirements: 8.4, 9.2, 10.3, 14.1, 14.13, 15.9, 17.3, 17.4_

  - [x] 9.3 Add the site settings section to the admin page in `src/accounts-ui.js`
    - `ENDPOINTS.adminSettings`; `網站設定` section with the `setting-receipt-ai` select, source help text, PATCH submit, toast, and `showFormError`
    - _Requirements: 11.11_

  - [x] 9.4 Show the policy reason in `src/receipt-ai-client.js` and `src/expenses-ui.js`
    - `normalizeAiStatus` passes `disabledReason`; `policy` shows `管理員已限制 AI 收據辨識，請手動輸入。`
    - _Requirements: 11.4_

  - [x] 9.5 Update the account invite dialog in `src/app.js`
    - Denial text `只有這趟旅行的成員或管理員可以發出邀請。` in `allowAccountAction` and `createAccountInvite`
    - `invite()` in account mode opens the dialog through `openAccountInviteDialog()`, which loads `GET /api/trips/<tripId>/invites`; opening no longer creates a link
    - `renderAccountInviteDialog()` per the design: the just-created link with copy button, single-use and expiry text, and `連結只會顯示這一次，請現在複製。`; the in-dialog error; `建立邀請連結` (`data-action="create-invite"`); `尚未使用的邀請連結` list with creator name, created and expiry times, and a `撤銷` button (`data-action="revoke-invite"`, `data-id`) per entry; empty text `目前沒有可撤銷的邀請連結。`; the localhost notice only in Local_Mode; all server text through `e()`
    - `create-invite` stores `urlPath` and `id`, reloads the list, and shows a 409 inside the dialog with the list kept
    - `revoke-invite`(id) calls `POST /api/trips/<tripId>/invites/<id>/revoke` with `expectedUserId`, notifies `邀請連結已撤銷`, clears the shown link when its id matches, and reloads the list (also after an error)
    - `allowAccountAction` allows `create-invite` and `revoke-invite` under the `canInvite` rule
    - _Requirements: 16.10, 16.11, 18.1, 19.10, 19.11, 19.12, 19.13_

  - [x] 9.6 Update `tests/accounts.e2e.js` for member invites
    - "invited guest edits shared content but cannot delete trip, remove items or invite others": the guest sees `邀請旅伴`, `canInvite` is true, and the guest's invite request returns 201; rename to "…but cannot delete trip or remove items"
    - _Requirements: 13.19, 16.1, 16.10_

  - [x] 9.7 Create `tests/invite-registration.e2e.js`
    - Signed-out visitor sees the preview above the form, registers, and lands on the trip
    - A second signed-out visitor opening the same link sees the invalid-link page
    - _Requirements: 14.1, 14.13, 15.9, 17.3_

  - [x] 9.8 Create `tests/invite-links.e2e.js` for the open-link list
    - The owner opens the dialog with no links and sees `目前沒有可撤銷的邀請連結。`; `建立邀請連結` shows the link and adds one list entry
    - A Trip_Member creates a link from the trip page; it appears in the owner's list, and the owner's link does not appear in the member's list
    - `撤銷` removes the entry after the reload, and the revoked link shows the invalid-link page
    - A member at the 5-link limit sees the 409 message inside the dialog with the list still shown, revokes one link, and creates again
    - _Requirements: 13.20, 16.10, 16.11, 19.1, 19.2, 19.10, 19.11, 19.12, 19.13_

- [x] 10. Update the service worker build
  - [x] 10.1 Update `scripts/build.mjs`
    - Generated `sw.js` starts with `const PUBLISHED=false;`; cache name gets `-p` when published; navigations to `/demo` or `/demo/…` return without `respondWith` when published
    - _Requirements: 9.3, 9.5, 9.6_

  - [x] 10.2 Create `tests/build-sw.test.js`
    - The generated service worker contains exactly one `const PUBLISHED=false;`, the `/demo` guard, and the mode-dependent cache name; after the `swResponse` rewrite it contains `const PUBLISHED=true;`
    - _Requirements: 9.3, 9.6_

- [x] 11. Write the deployment documentation
  - [x] 11.1 Create `docs/deploy-nginx.md`
    - Settings table with Local_Mode and Published_Mode defaults (`CAMPING_REGISTRATION` fixed to `closed`, `open` stops startup), ordered steps, certificates, HSTS, future subdomains, LAN access, registration and invitation links (locked sign-up, member invites, single use, 7-day expiry, preview visible to link holders, the open-link list in the invite dialog with per-link revoke, links shown only once, limits 5 and 20, no site-wide limit), receipt AI policy, backup and restore, and the full Example_Nginx_Config
    - _Requirements: 5.4, 5.5, 5.6, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14_

  - [x] 11.2 Link the guide from `README.md`
    - Add the link in the "GitHub and hosting" and "Network security" text
    - _Requirements: 12.15_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Run `bun test tests`, then `bun run build` and `node scripts/check-accounts.mjs tests/accounts.e2e.js tests/invite-registration.e2e.js tests/invite-links.e2e.js tests/trip-deletion.e2e.js tests/vehicle-departures.e2e.js tests/brand.e2e.js` with `CAMPING_BUN` set. Ensure all tests pass, ask the user if questions arise.

## Notes

- No task is marked optional, matching the other specs in this repository, which do not use the `*` marker. Property tests are required because Requirement 13 calls for them.
- The design chooses `fast-check` for property tests. Existing suites such as `tests/mobile-swipe.test.js` use seeded `mulberry32`/`forAll` helpers instead; both can coexist.
- Tasks 2.2, 4.1–4.5, 4.12, 6.1, and 7.3 all write `server/accounts.js`, so they run in separate waves.
- Tasks 2.4, 2.5, 4.11, and 7.4 write `tests/publish.test.js`; tasks 1.2–1.5 write `tests/deploy-config.test.js`; tasks 4.7–4.10 write `tests/invites.test.js`; tasks 4.13 and 4.14 write `tests/invite-list.test.js`; tasks 9.2 and 9.3 write `src/accounts-ui.js`. Each group runs in separate waves. Task 9.5 is the only task that writes `src/app.js`.
- Revoke works only by invite id (`POST /api/trips/<tripId>/invites/<inviteId>/revoke`). The token-based revoke route from the earlier draft is not built; the create response returns the `id` so the just-created link uses the same route.
- Tasks 1.2 and 6.3 both edit `package.json` and run in different waves.
- `scripts/check-accounts.mjs` runs the server in Local_Mode with an in-memory database and creates the first admin through `/setup`, so e2e covers the Local_Mode single-use and invite flows; Published_Mode behavior is covered by the API tests.
- The app has no "leave trip" or "remove member" route today. Task 4.2 adds `revokeCreatorTripInvites` so a future path can meet Requirement 16.7, and the use-time creator check in `inviteForUse` covers the gap meanwhile.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2", "7.2"] },
    { "id": 2, "tasks": ["1.3", "2.3", "2.4", "4.1"] },
    { "id": 3, "tasks": ["1.4", "2.5", "4.2"] },
    { "id": 4, "tasks": ["1.5", "4.3"] },
    { "id": 5, "tasks": ["4.4"] },
    { "id": 6, "tasks": ["4.5"] },
    { "id": 7, "tasks": ["4.6", "4.7", "4.11", "4.12"] },
    { "id": 8, "tasks": ["4.8", "4.13", "6.1"] },
    { "id": 9, "tasks": ["4.9", "4.14", "6.2", "6.3", "7.3", "9.1", "9.2", "9.4", "9.5", "10.1"] },
    { "id": 10, "tasks": ["4.10", "6.4", "7.4", "9.3", "9.6", "9.7", "9.8", "10.2", "11.1", "11.2"] }
  ]
}
```
