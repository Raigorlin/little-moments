# Requirements Document

## Introduction

This feature prepares the account version of the app (login, register, invitations, account homes, trips, admin) to be published at `https://www.our-littlemoments.com`. The operator runs nginx on the same host. nginx terminates TLS and proxies to the app process, which keeps listening on `127.0.0.1:5173`. Devices on the operator's LAN (for example `192.168.1.0/24` and `10.20.1.0/24`) also reach the site through nginx over HTTPS at the same hostname, using local DNS or hairpin NAT. The `/demo/` local planner is not published.

Today the server assumes browsers talk to it directly. Behind nginx that assumption breaks in several ways:

- `server/accounts.js` compares the `Origin` header of every non-GET request with `new URL(request.url).origin`. Behind nginx that URL is `http://`, so every mutating request, including login, returns 403.
- `cookieHeader` adds `Secure` only when the request URL protocol is `https:`, which never happens behind nginx.
- First-admin setup is allowed when the Host is a loopback name and the peer IP is loopback. Behind nginx every peer IP is `127.0.0.1`, so a remote client that sends `Host: localhost` through nginx could create the first administrator.
- Rate limits key on `server.requestIP`, so all visitors share the bucket for `127.0.0.1`.
- `server/http.js` has no hostname check, so the existing test "unexpected hostname rejected even if DNS points to localhost" in `tests/http.test.js` fails.
- `/demo/` is routed by `server/http.js`, and the service worker can serve the cached shell for any navigation.
- `/api/register` is open to anyone, and receipt AI (OpenAI key in `.secrets/openai_api_key`) is usable by any signed-in account with trip edit permission.

This feature adds explicit deployment configuration, makes the server correct and safe behind a trusted reverse proxy, disables the local planner and the web first-admin setup in the published deployment, adds a command-line tool that creates the first administrator, locks public registration in the published deployment so that new accounts come only from trip invitations, lets every trip member create invitation links, makes invitation links single-use, lists a trip's open invitation links with a per-link revoke, shows signed-out visitors a minimal invitation preview, adds an admin control for the receipt AI policy, validates configuration at startup, and documents the nginx and deployment setup. Without the new configuration, local development and the existing Docker setup, including its trusted-LAN access by IP address, behave as they do today. Scope is limited to code, configuration, tests, and documentation. Deploying to or changing the operator's server is out of scope.

## Glossary

- **App_Server**: The Bun process started by `scripts/serve.mjs`, consisting of the HTTP handler in `server/http.js` and the account service in `server/accounts.js`.
- **Startup_Validator**: The logic that reads and checks the Deployment_Config before the App_Server starts listening.
- **Deployment_Config**: The set of settings read from environment variables at startup: Published_Mode, Public_Origin, Trusted_Proxies, Local_Extra_Hosts, Non_Loopback_Bind_Opt_In, Registration_Policy, and Receipt_AI_Policy_Seed. Final variable names are chosen in the design and use the existing `CAMPING_` prefix.
- **Boolean_Setting**: A Deployment_Config setting whose accepted values are `1` (on), `0` (off), and unset (off).
- **Published_Mode**: A Boolean_Setting that marks the App_Server as serving the public deployment. Default: off.
- **Local_Mode**: The App_Server state when Published_Mode is off. Local_Mode is the default.
- **Public_Origin**: The exact public origin of the deployment, `https://www.our-littlemoments.com`: scheme, hostname, and optional port, without path, query, fragment, or credentials.
- **Public_Hostname**: The hostname part of the Public_Origin, `www.our-littlemoments.com`.
- **Apex_Hostname**: The hostname `our-littlemoments.com`.
- **Bind_Host**: The address the App_Server listens on, set by the existing `HOST` variable. Default: `127.0.0.1`.
- **Loopback_Host**: One of the hostnames `127.0.0.1`, `localhost`, or `[::1]`.
- **Loopback_Address**: An IPv4 address in `127.0.0.0/8`, the IPv6 address `::1`, or an IPv4-mapped IPv6 loopback address.
- **IP_Literal_Host**: A Host hostname that is an IPv4 address or a bracketed IPv6 address, for example `192.168.1.10`.
- **Non_Loopback_Bind_Opt_In**: A Boolean_Setting that permits a Bind_Host that is not a Loopback_Address. The existing `CAMPING_DOCKER_LOCAL_ONLY=1` setting also counts as this opt-in.
- **Docker_Local_Only**: The existing `CAMPING_DOCKER_LOCAL_ONLY=1` setting used by the Dockerfile.
- **Trusted_Proxies**: A list of IP addresses whose forwarding headers the App_Server trusts. Default in Local_Mode: empty. Default in Published_Mode: `127.0.0.1` and `::1`.
- **Direct_Peer**: The IP address of the TCP peer as reported by `server.requestIP`.
- **Forwarding_Headers**: The request headers `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, and `Forwarded`.
- **Proxied_Request**: A request whose Direct_Peer is in Trusted_Proxies and that carries an `X-Forwarded-For` header.
- **Direct_Local_Request**: A request whose Direct_Peer is a Loopback_Address, whose Host is a Loopback_Host, and that carries none of the Forwarding_Headers.
- **Client_Address**: The address the App_Server attributes a request to. For a Proxied_Request, the right-most `X-Forwarded-For` entry that is not in Trusted_Proxies. For any other request, the Direct_Peer.
- **Allowed_Hosts**: The hostnames the App_Server accepts in the request Host. In Local_Mode: the Loopback_Hosts, every IP_Literal_Host, and the Local_Extra_Hosts. In Published_Mode: the Public_Hostname, plus the Loopback_Hosts for Direct_Local_Requests only.
- **Local_Extra_Hosts**: An optional list of additional hostnames accepted in Local_Mode only, for example a LAN name such as `camp.lan`.
- **Expected_Origin**: The origin a mutating request must carry in its `Origin` header. For a Proxied_Request in Published_Mode: the Public_Origin. For any other request: the origin of the request URL, which is the current behavior.
- **Mutating_Request**: An `/api/` request whose method is not GET.
- **Session_Cookie**: The `ggc_session` cookie set by `cookieHeader` in `server/accounts.js`.
- **Web_First_Admin_Setup**: The `/setup` page and the `POST /api/setup` route that create the first administrator from a browser while no user exists.
- **Create_Admin_CLI**: A command-line script that the operator runs on the server to create the first administrator in the SQLite database named by `CAMPING_DB`.
- **Account_Validation**: The existing username, display name, and password rules and the scrypt password hashing in `server/accounts.js` that `POST /api/register` applies.
- **Rate_Limiter**: The `RateLimiter` in `server/accounts.js` with the `loginUser`, `loginClient`, and `register` limits.
- **Trip_Manager**: For a given trip, the trip owner or an account with the admin role.
- **Trip_Member**: For a given trip, an account with a row in `trip_members` for that trip.
- **Inviter**: For a given trip, an account that may create Invite_Tokens for the trip: a Trip_Manager or a Trip_Member. This is the `canInvite` capability.
- **Invite_Token**: The secret token in an invitation link `/invite/<token>`. An Inviter creates an Invite_Token. An Invite_Token expires 7 days after creation and can add at most one account to the trip.
- **Used_Invite**: An Invite_Token that has added an account to its trip. The `invites` row records the time and the account in the `used_at` and `used_by` columns.
- **Active_Invite**: An Invite_Token that is not expired, not revoked, and not a Used_Invite.
- **Invite_ID**: A random UUID that identifies one `invites` row. The Invite_ID is not secret, cannot be used to view or join a trip, and differs from the Invite_Token and from the stored token hash.
- **Invite_List**: The list of a trip's Active_Invites that the requesting Inviter may revoke: every Active_Invite of the trip for a Trip_Manager, and the Active_Invites that the requesting account created for any other Inviter.
- **Invitation_Dialog**: The dialog on the account trip page in `src/app.js` that opens from the invite button.
- **Valid_Invite**: An Active_Invite whose creator is not deleted and is still an Inviter for the invite's trip, and whose trip is not deleted.
- **Member_Invite_Limit**: The maximum number of Active_Invites that one Inviter who is not a Trip_Manager can hold for one trip: 5.
- **Trip_Invite_Limit**: The maximum number of Active_Invites per trip: 20.
- **Invalid_Invite_Message**: The existing message 邀請連結無效或已過期。, returned with status 404 for every Invite_Token that cannot be used.
- **Invite_Join**: The existing signed-in join through `POST /api/invites/<token>/join`.
- **Invite_Registration**: Creating a new account through a Valid_Invite and joining the invite's trip in the same step.
- **Invite_Preview**: The minimal trip information shown for a Valid_Invite without sign-in: trip title, destination, start date, end date, and the display name of the Invite_Token creator.
- **Local_Planner**: The browser-only planner at `/demo/` (`src/app.js` started without an account context).
- **App_Shell**: `index.html` with `entry.js` and `accounts-ui.js`, which decide whether to start the Local_Planner or the account UI.
- **Service_Worker**: The `sw.js` file generated by `scripts/build.mjs`.
- **Registration_Policy**: A setting that controls `POST /api/register`. Values: `open` (anyone can register, the current behavior) and `closed` (open registration is refused). Local_Mode accepts both values. Published_Mode always uses `closed`. Invite_Registration is available under both values.
- **Receipt_AI_Policy**: A runtime setting that controls who can use receipt AI recognition. Values: `all` (any account with trip edit permission, the current behavior), `admins` (only accounts with the admin role), and `off`.
- **Settings_Store**: A table in the accounts SQLite database that stores runtime settings, including the Receipt_AI_Policy.
- **Receipt_AI_Policy_Seed**: An optional environment setting that supplies the Receipt_AI_Policy while the Settings_Store holds no Receipt_AI_Policy value.
- **Admin_Page**: The existing `/admin` page in `src/accounts-ui.js`.
- **Deployment_Guide**: The documentation added to the repository for publishing behind nginx.
- **Example_Nginx_Config**: An nginx configuration example included in the Deployment_Guide.
- **Request_Body_Limit**: The App_Server maximum request body size, currently 4,194,304 bytes (4 MiB) in `scripts/serve.mjs`.

## Requirements

### Requirement 1: Deployment Configuration With Unchanged Defaults

**User Story:** As the operator, I want publishing to be switched on by explicit settings, so that local development and the existing Docker setup keep working without changes.

#### Acceptance Criteria

1. THE App_Server SHALL read the Deployment_Config from environment variables at startup.
2. WHILE the Deployment_Config contains none of the new settings, THE App_Server SHALL run in Local_Mode with the Bind_Host, port, routes, Origin check, cookie attributes, Web_First_Admin_Setup rules, Rate_Limiter keys, Registration_Policy `open`, and Receipt_AI_Policy `all` that the App_Server uses before this feature.
3. WHILE the Docker_Local_Only setting is on and Published_Mode is off, THE App_Server SHALL apply the same Web_First_Admin_Setup rule for the Docker container that the App_Server applies before this feature.
4. WHEN the App_Server finishes starting in Published_Mode, THE App_Server SHALL log the Public_Origin, the Bind_Host and port, the Registration_Policy, and the effective Receipt_AI_Policy.
5. THE App_Server SHALL keep secret values, including the OpenAI API key, out of every startup log line.

### Requirement 2: Startup Validation

**User Story:** As the operator, I want the server to refuse to start with an unsafe configuration, so that a typo cannot expose the site in an insecure state.

#### Acceptance Criteria

1. IF Published_Mode is on and the Public_Origin is missing, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the missing setting.
2. IF Published_Mode is on and the Public_Origin does not use the `https:` scheme, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the setting.
3. IF the Public_Origin contains a path other than `/`, a query, a fragment, or credentials, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the setting.
4. IF the Bind_Host is not a Loopback_Address and Non_Loopback_Bind_Opt_In is off, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that explains the opt-in.
5. IF Published_Mode is on and Docker_Local_Only is on, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that explains that the two settings are incompatible.
6. IF a Trusted_Proxies entry is not a valid IPv4 or IPv6 address, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the invalid entry.
7. IF the Registration_Policy or the Receipt_AI_Policy_Seed has a value outside its defined values, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that lists the accepted values.
8. IF a Local_Extra_Hosts entry is not a valid hostname, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the invalid entry.
9. IF Published_Mode is on and Local_Extra_Hosts is set, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that states that Local_Extra_Hosts applies only to Local_Mode.
10. IF a Boolean_Setting has a value other than `1` or `0`, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the setting and lists the accepted values.
11. WHEN every Deployment_Config setting is valid, THE Startup_Validator SHALL return a normalized configuration object that the App_Server uses for request handling.
12. IF Published_Mode is on and the Registration_Policy is set to `open`, THEN THE Startup_Validator SHALL stop startup with a non-zero exit code and a message that names the setting and states that public registration cannot be opened in Published_Mode.

### Requirement 3: Host Allowlist

**User Story:** As the operator, I want requests for unknown hostnames rejected, so that DNS rebinding and spoofed Host headers cannot reach the app.

#### Acceptance Criteria

1. WHEN the App_Server receives a request whose Host hostname is not in the Allowed_Hosts, THE App_Server SHALL respond with status 403 and the security headers before the request reaches the account service or static file handling.
2. WHEN the App_Server receives a request whose Host hostname is in the Allowed_Hosts, THE App_Server SHALL continue to the existing API and static file handling.
3. THE App_Server SHALL compare Host hostnames case-insensitively and ignore the port.
4. WHILE Published_Mode is on, THE App_Server SHALL accept a Loopback_Host only for a Direct_Local_Request.
5. WHILE Published_Mode is on, THE App_Server SHALL reject every IP_Literal_Host that is not a Loopback_Host, and SHALL reject the Apex_Hostname.
6. WHILE Published_Mode is off, THE App_Server SHALL accept every IP_Literal_Host, so that the existing Docker trusted-LAN access at `http://<host-LAN-IPv4>:5182` keeps working without new settings.
7. WHERE Local_Extra_Hosts is set in Local_Mode, THE App_Server SHALL accept each listed hostname in addition to the Loopback_Hosts and IP_Literal_Hosts.
8. WHEN the HTTP handler is created without a Deployment_Config, THE App_Server SHALL apply the Local_Mode Allowed_Hosts.

### Requirement 4: Origin Check Against the Public Origin

**User Story:** As a signed-in member using the public site, I want login and edits to succeed through nginx, so that the published site works, while cross-site requests stay blocked.

#### Acceptance Criteria

1. WHEN the App_Server receives a Mutating_Request whose `Origin` header equals the Expected_Origin, THE App_Server SHALL process the request.
2. IF a Mutating_Request has no `Origin` header or an `Origin` header that differs from the Expected_Origin, THEN THE App_Server SHALL respond with status 403 and the existing message 請求來源不被允許。.
3. WHILE Published_Mode is on, THE App_Server SHALL use the Public_Origin as the Expected_Origin for every Proxied_Request.
4. WHILE Published_Mode is on, THE App_Server SHALL use the request URL origin as the Expected_Origin for every Direct_Local_Request.
5. THE App_Server SHALL compare origins as exact strings after the Startup_Validator normalizes the Public_Origin.

### Requirement 5: Secure Cookies and HTTPS Headers

**User Story:** As a member, I want my session cookie to travel only over HTTPS on the public site, so that the session cannot leak over plain HTTP.

#### Acceptance Criteria

1. WHILE Published_Mode is on, THE App_Server SHALL include the `Secure` attribute in every Session_Cookie set or cleared in response to a Proxied_Request.
2. THE App_Server SHALL keep the `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Max-Age` attributes on the Session_Cookie.
3. WHILE Published_Mode is off, THE App_Server SHALL include the `Secure` attribute only when the request URL protocol is `https:`.
4. THE Example_Nginx_Config SHALL send the header `Strict-Transport-Security: max-age=15552000` on every HTTPS response for the Public_Hostname and the Apex_Hostname, without the `includeSubDomains` and `preload` directives.
5. THE Example_Nginx_Config SHALL redirect HTTP requests for the Public_Hostname and the Apex_Hostname to the same path on the Public_Origin with status 301.
6. THE Example_Nginx_Config SHALL redirect HTTPS requests for the Apex_Hostname to the same path on the Public_Origin with status 301.

### Requirement 6: Client Address From Trusted Proxies

**User Story:** As the operator, I want the server to see each visitor's real address only when the request comes through my nginx, so that rate limits work per visitor and visitors cannot spoof their address.

#### Acceptance Criteria

1. WHEN the App_Server receives a Proxied_Request, THE App_Server SHALL use as the Client_Address the right-most `X-Forwarded-For` entry that is not in Trusted_Proxies.
2. WHEN the Direct_Peer is not in Trusted_Proxies, THE App_Server SHALL use the Direct_Peer as the Client_Address and ignore every Forwarding_Header.
3. IF every `X-Forwarded-For` entry of a Proxied_Request is in Trusted_Proxies, THEN THE App_Server SHALL use the left-most entry as the Client_Address.
4. IF the `X-Forwarded-For` entry selected as the Client_Address is not a valid IPv4 or IPv6 address, THEN THE App_Server SHALL respond with status 400 and the security headers.
5. THE App_Server SHALL treat IPv4 addresses and their IPv4-mapped IPv6 form as the same address when matching Trusted_Proxies.
6. THE App_Server SHALL ignore `X-Forwarded-Host` and `X-Forwarded-Proto` values when building the Expected_Origin and the Session_Cookie attributes.

### Requirement 7: Per-Client Rate Limiting

**User Story:** As a visitor, I want one abusive visitor to not lock everyone out of login and registration, so that the shared nginx address does not turn rate limits into a site-wide lockout.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL key the `loginClient` and `register` limits on the Client_Address.
2. WHEN two Proxied_Requests carry different Client_Addresses, THE Rate_Limiter SHALL count the two requests in separate buckets.
3. WHEN a client exceeds the `loginClient` or `register` limit, THE App_Server SHALL respond with status 429 to that Client_Address while other Client_Addresses remain below their limits.
4. THE Rate_Limiter SHALL keep the existing `loginUser` limit keyed on the submitted username.

### Requirement 8: First Administrator Created by the Operator

**User Story:** As the operator, I want to create the first administrator with a command on the server, so that nobody on the internet can claim the site before I do.

#### Acceptance Criteria

1. WHILE Published_Mode is on, THE App_Server SHALL respond to `GET /setup` and `GET /setup/` with status 404 and the security headers.
2. WHILE Published_Mode is on, THE App_Server SHALL respond to `POST /api/setup` with status 404 and the existing API not-found message 找不到這個 API。, regardless of the request Host, Direct_Peer, or Forwarding_Headers.
3. WHEN the App_Server finishes starting in Published_Mode and the database contains no user, THE App_Server SHALL log a message that tells the operator to run the Create_Admin_CLI and names the command.
4. WHILE Published_Mode is on and the database contains no user, THE App_Shell SHALL show a page stating that the site is not set up yet instead of redirecting to `/setup`.
5. WHILE Published_Mode is off, THE App_Server SHALL keep the Web_First_Admin_Setup rules, including the existing status 403 message 首次管理員設定只能在本機進行。 and status 409 message 管理員已設定完成。.
6. WHEN the operator runs the Create_Admin_CLI, THE Create_Admin_CLI SHALL open the SQLite database at `CAMPING_DB`, or at `data/accounts.sqlite` when `CAMPING_DB` is unset.
7. IF the database already contains at least one user, THEN THE Create_Admin_CLI SHALL exit with a non-zero exit code and a message that setup is already complete, without changing the database.
8. WHEN the Create_Admin_CLI runs on a terminal, THE Create_Admin_CLI SHALL prompt for the username, the display name, the password, and a password confirmation, and SHALL hide the password characters while the operator types them.
9. IF the Create_Admin_CLI receives a command-line argument other than `--help`, THEN THE Create_Admin_CLI SHALL exit with a non-zero exit code and a usage message, without reading a password.
10. THE Create_Admin_CLI SHALL read the password only from the interactive prompt, and SHALL ignore every environment variable as a password source.
11. IF standard input is not a terminal, THEN THE Create_Admin_CLI SHALL exit with a non-zero exit code and a message that an interactive terminal is required.
12. IF the username, display name, or password fails Account_Validation, or the two password entries differ, THEN THE Create_Admin_CLI SHALL print the validation message and prompt for the value again.
13. WHEN the input passes Account_Validation, THE Create_Admin_CLI SHALL create one account with the admin role and a scrypt password hash using the same Account_Validation code as the App_Server, and SHALL write an audit entry for the creation.
14. IF a user is created by another process between the Create_Admin_CLI check and its write, THEN THE Create_Admin_CLI SHALL exit with a non-zero exit code without creating a second account.
15. THE Create_Admin_CLI SHALL keep the password out of its output and out of the audit entry.
16. THE Create_Admin_CLI SHALL accept an injected prompt implementation from tests, so that tests can supply input without a password in arguments or environment variables.

### Requirement 9: Local Planner Disabled in Published Mode

**User Story:** As the operator, I want the `/demo/` local planner unavailable on the public site, so that only the account version is published.

#### Acceptance Criteria

1. WHILE Published_Mode is on, THE App_Server SHALL respond to `/demo` and `/demo/` with status 404 and the security headers.
2. WHILE Published_Mode is on, THE App_Shell SHALL show a not-found page instead of starting the Local_Planner when the page path is `/demo` or starts with `/demo/`.
3. WHILE Published_Mode is on, THE Service_Worker SHALL answer navigations to `/demo` or paths under `/demo/` without serving the cached App_Shell.
4. WHILE Published_Mode is on, THE App_Server SHALL keep serving the shared `app.js` and chunk assets that account trip pages load.
5. WHILE Published_Mode is off, THE App_Server, App_Shell, and Service_Worker SHALL serve and start the Local_Planner at `/demo/` as before this feature.
6. THE App_Server SHALL deliver the Published_Mode state to the App_Shell and the Service_Worker at runtime, so that one build output serves both Local_Mode and Published_Mode.

### Requirement 10: Registration Policy

**User Story:** As the operator, I want public sign-up locked on the public site and configurable locally, so that only people invited by current trip members can create accounts on the public site.

#### Acceptance Criteria

1. WHILE Published_Mode is off and the Registration_Policy is `open`, THE App_Server SHALL process `POST /api/register` as before this feature.
2. WHILE the Registration_Policy is `closed`, THE App_Server SHALL respond to every `POST /api/register` request that passes the Origin check with status 403 and a message stating that registration is closed, before reading the request body and without creating an account.
3. WHILE the Registration_Policy is `closed`, THE App_Shell SHALL show the register page with a message that registration needs a trip invitation instead of the registration form.
4. WHILE Published_Mode is on, THE App_Server SHALL apply the Registration_Policy `closed`.
5. WHILE Published_Mode is off and the Registration_Policy is not set, THE App_Server SHALL apply the Registration_Policy `open`.
6. WHEN the App_Server responds to `GET /api/session`, THE App_Server SHALL include whether open registration is available, whether Invite_Registration is available, and whether Web_First_Admin_Setup is available.
7. WHILE Published_Mode is on, THE App_Server SHALL create member accounts only through Invite_Registration with a Valid_Invite created by an Inviter of the invite's trip.

### Requirement 11: Receipt AI Policy With Admin Control

**User Story:** As the operator, I want to switch who can send receipts to OpenAI from the admin page, so that I can control API spending without restarting the server.

#### Acceptance Criteria

1. WHILE the Receipt_AI_Policy is `all`, THE App_Server SHALL apply the receipt AI permission checks that the App_Server applies before this feature.
2. WHILE the Receipt_AI_Policy is `admins`, THE App_Server SHALL respond to receipt AI recognition requests from accounts without the admin role with status 403.
3. WHILE the Receipt_AI_Policy is `off`, THE App_Server SHALL report receipt AI as disabled in `GET /api/trips/{id}/receipt-ai` and respond to recognition requests with status 503.
4. WHEN the App_Server reports receipt AI status to an account that the Receipt_AI_Policy excludes, THE App_Server SHALL report receipt AI as disabled for that account with a reason that identifies the policy.
5. WHILE the Settings_Store holds no Receipt_AI_Policy value and the Receipt_AI_Policy_Seed is not set, THE App_Server SHALL apply the Receipt_AI_Policy `all` in both Local_Mode and Published_Mode.
6. WHILE the Settings_Store holds no Receipt_AI_Policy value and the Receipt_AI_Policy_Seed is set, THE App_Server SHALL apply the Receipt_AI_Policy_Seed value.
7. WHILE the Settings_Store holds a Receipt_AI_Policy value, THE App_Server SHALL apply the stored value and ignore the Receipt_AI_Policy_Seed.
8. WHEN an account with the admin role submits a Receipt_AI_Policy value of `all`, `admins`, or `off`, THE App_Server SHALL store the value in the Settings_Store, write an audit entry with the new value, and apply the value to the next receipt AI request without a restart.
9. IF an account without the admin role submits a Receipt_AI_Policy change, THEN THE App_Server SHALL respond with status 403 and leave the stored value unchanged.
10. IF an account with the admin role submits a Receipt_AI_Policy value outside `all`, `admins`, and `off`, THEN THE App_Server SHALL respond with status 400 and leave the stored value unchanged.
11. THE Admin_Page SHALL show the effective Receipt_AI_Policy, whether the value comes from the Settings_Store, the Receipt_AI_Policy_Seed, or the default, and a control to change the value.
12. WHEN the App_Server restarts, THE App_Server SHALL apply the Receipt_AI_Policy value held in the Settings_Store.
13. THE App_Server SHALL keep the existing per-user and global daily receipt AI limits under every Receipt_AI_Policy that permits recognition.

### Requirement 12: Deployment Documentation

**User Story:** As the operator, I want a deployment guide with a working nginx example, so that I can publish the site correctly without guessing.

#### Acceptance Criteria

1. THE Deployment_Guide SHALL list every Deployment_Config setting with its default in Local_Mode, its default in Published_Mode, and an example value for `https://www.our-littlemoments.com`.
2. THE Example_Nginx_Config SHALL contain a TLS server block for the Public_Hostname that proxies to `http://127.0.0.1:5173`.
3. THE Example_Nginx_Config SHALL set the `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` request headers sent to the App_Server.
4. THE Example_Nginx_Config SHALL contain `default_server` blocks for HTTP and HTTPS that close connections for unknown hostnames with `return 444`.
5. THE Example_Nginx_Config SHALL set `client_max_body_size` to a value no larger than the Request_Body_Limit of 4 MiB.
6. THE Example_Nginx_Config SHALL set a proxy read timeout longer than the 70-second receipt AI request timeout.
7. THE Deployment_Guide SHALL state that the TLS certificate must cover both the Public_Hostname and the Apex_Hostname.
8. THE Deployment_Guide SHALL explain that `includeSubDomains` can be added to the `Strict-Transport-Security` header once every subdomain of `our-littlemoments.com` serves HTTPS, and that `preload` is hard to undo.
9. THE Deployment_Guide SHALL explain that a future subdomain gets its own nginx server block and certificate coverage, and that unknown hostnames reach the `default_server` blocks.
10. THE Deployment_Guide SHALL describe the deployment steps in order: build, configure environment, start the App_Server on `127.0.0.1:5173`, create the first administrator with the Create_Admin_CLI, enable the nginx site, and verify login over HTTPS.
11. THE Deployment_Guide SHALL describe LAN access through nginx by pointing the Public_Hostname at the server's LAN IP address with split DNS, a router DNS entry, or a hosts-file entry, using the subnets `192.168.1.0/24` and `10.20.1.0/24` as examples, and SHALL state that the App_Server port stays bound to `127.0.0.1`.
12. THE Deployment_Guide SHALL describe backing up `data/accounts.sqlite` with a method that produces a consistent copy that includes committed WAL content while the App_Server is running, and restoring the copy with the App_Server stopped.
13. THE Deployment_Guide SHALL state that the `/demo/` local planner and the web first-admin setup are unavailable in Published_Mode.
14. THE Deployment_Guide SHALL state that public registration is locked in Published_Mode, that every trip member can create invitation links, that each link adds at most one account and expires after 7 days, that anyone holding an unused link sees the Invite_Preview and can create an account with the link, and that the creator or a Trip_Manager can revoke an unused link from the Invite_List in the Invitation_Dialog.
15. THE README SHALL link to the Deployment_Guide.

### Requirement 13: Automated Tests

**User Story:** As a developer, I want tests for the new configuration and proxy logic, so that the published deployment stays safe as the code changes.

#### Acceptance Criteria

1. THE test suite SHALL pass the existing test "unexpected hostname rejected even if DNS points to localhost" in `tests/http.test.js` without changing the test's expected status of 403.
2. THE test suite SHALL include unit tests for the Startup_Validator that cover each rejection in Requirement 2 and one valid Published_Mode configuration for `https://www.our-littlemoments.com`.
3. THE test suite SHALL include unit tests for Client_Address resolution that cover a trusted Direct_Peer, an untrusted Direct_Peer with spoofed Forwarding_Headers, multiple `X-Forwarded-For` entries, and an invalid selected entry.
4. THE test suite SHALL include tests for the Allowed_Hosts in both modes, including an IP_Literal_Host in Local_Mode and the Apex_Hostname in Published_Mode.
5. THE test suite SHALL include tests that a Proxied_Request in Published_Mode with `Origin` equal to the Public_Origin can log in and receives a Session_Cookie with the `Secure` attribute.
6. THE test suite SHALL include tests that `/setup` and `POST /api/setup` return 404 in Published_Mode for a Proxied_Request and for a Direct_Local_Request.
7. THE test suite SHALL include tests for the Create_Admin_CLI that use an injected prompt and cover a successful creation with an audit entry, refusal when a user exists, a validation retry, a password mismatch, a rejected command-line argument, and a non-terminal standard input.
8. THE test suite SHALL include tests that `/demo/` returns 404 in Published_Mode and 200 in Local_Mode.
9. THE test suite SHALL include tests for each Registration_Policy value.
10. THE test suite SHALL include tests for Invite_Registration that cover a successful registration and join, a closed Registration_Policy, an invalid or expired Invite_Token, a Used_Invite, a taken username, a participant name conflict that leaves no new account and leaves the Invite_Token unused, and the `register` rate limit keyed on the Client_Address.
11. THE test suite SHALL include tests for each Receipt_AI_Policy value, the Receipt_AI_Policy_Seed, an admin change that applies without restart and writes an audit entry, a non-admin change rejected with 403, and an invalid value rejected with 400.
12. THE test suite SHALL include a test that two Proxied_Requests with different Client_Addresses use separate `loginClient` buckets.
13. WHEN the full existing test suite runs without any Deployment_Config settings, THE test suite SHALL pass the tests that passed before this feature, with the tests listed in criterion 19 updated to the new invitation rules.
14. THE test suite SHALL include tests for the Invite_Preview that cover the exact response fields for a Valid_Invite, an identical 404 response for a malformed, unknown, expired, revoked, used, creator-deleted, creator-without-rights, and trip-deleted Invite_Token, the `invitePreview` rate limit keyed on the Client_Address, a preview that leaves the Invite_Token unused, and `GET /api/invites/<token>` still returning 401 without a session.
15. THE test suite SHALL include tests for Inviters that cover the `canInvite` capability for the trip owner, a Trip_Member, an admin who is not a Trip_Member, and an account outside the trip; invite creation by a Trip_Member; the Member_Invite_Limit; the Trip_Invite_Limit counting only Active_Invites; and revocation of Active_Invites when the creator is deleted or loses the admin role.
16. THE test suite SHALL include tests for single-use Invite_Tokens that cover a second account receiving 404 after an Invite_Join and after an Invite_Registration, an already-joined account reopening and rejoining a Used_Invite without change, a failed join that leaves the Invite_Token unused, and the upgrade of an `invites` table without the usage columns.
17. THE test suite SHALL include tests for the per-link revoke by Invite_ID that cover revocation by the creator and by a Trip_Manager, a 403 for another Trip_Member, a 404 for a malformed, unknown, used, expired, or revoked Invite_ID and for an Invite_ID of another trip, a 404 for an account that is not an Inviter for the trip, a 401 without a session, the Origin check, and the `invite.revoke` audit entry.
18. THE test suite SHALL include a Startup_Validator test that `CAMPING_REGISTRATION=open` with Published_Mode on stops startup.
19. THE test suite SHALL update these existing tests to the new invitation rules and keep their other assertions: in `tests/accounts.test.js`, "members can edit and patch but not invite", the `MEMBER` capability constant and "list and envelope expose capabilities; forged permission fields are ignored", and "deleting a member of a full 100-person trip keeps the trip valid" (the 101st account uses a new Invite_Token); in `tests/accounts.e2e.js`, "invited guest edits shared content but cannot delete trip, remove items or invite others".
20. THE test suite SHALL include tests for the Invite_List that cover the listing scope for the trip owner, an admin who is not a Trip_Member, a Trip_Member, and an account outside the trip; the absence of every Invite_Token and token hash from the response; the exclusion of used, expired, and revoked invites; the upgrade of an `invites` table without the Invite_ID column to unique Invite_IDs for every existing row; and a browser test that lists the open links in the Invitation_Dialog and revokes one.

### Requirement 14: Registration Through Trip Invitations

**User Story:** As a person who received a trip invitation link, I want to create my account on the invitation page and join the trip in one step, so that I can join even though open registration is closed.

#### Acceptance Criteria

1. WHEN a visitor who is not signed in opens `/invite/<token>` for a Valid_Invite, THE App_Shell SHALL show the Invite_Preview followed by an account creation form with username, display name, password, password confirmation, trip name, and optional trip role fields, and a link to sign in with an existing account.
2. WHEN the App_Server receives an Invite_Registration request for a Valid_Invite with input that passes Account_Validation, THE App_Server SHALL create a member account, add the account to the invite's trip as a new participant, mark the Invite_Token as a Used_Invite, start a session with a Session_Cookie, and respond with the account and the trip ID.
3. THE App_Server SHALL create the account, insert the trip membership, and mark the Invite_Token as used for an Invite_Registration in one database transaction.
4. IF any step of an Invite_Registration fails, THEN THE App_Server SHALL leave the database without the new account and without the new trip membership, and SHALL leave the Invite_Token unused.
5. THE App_Server SHALL accept Invite_Registration under both Registration_Policy values.
6. IF the Invite_Token of an Invite_Registration request is not a Valid_Invite, including a Used_Invite, THEN THE App_Server SHALL respond with status 404 and the Invalid_Invite_Message.
7. IF the username of an Invite_Registration request is already taken, THEN THE App_Server SHALL respond with status 409 and the existing message 這個帳號名稱已被使用。.
8. IF the trip name of an Invite_Registration request matches another participant or the trip is full, THEN THE App_Server SHALL respond with status 409 and the participant validation message.
9. THE App_Server SHALL count every Invite_Registration request against the `register` limit keyed on the Client_Address, the same bucket that `POST /api/register` uses.
10. THE App_Server SHALL apply the Mutating_Request Origin check to Invite_Registration requests.
11. IF the database contains no user, THEN THE App_Server SHALL respond to an Invite_Registration request with status 409.
12. WHEN an Invite_Registration succeeds, THE App_Server SHALL write audit entries for the account creation and the trip join.
13. WHEN an Invite_Registration succeeds, THE App_Shell SHALL open the joined trip for the new account.
14. THE App_Server SHALL apply the Invite_Token rules of Requirements 16 and 17 to Invite_Registration: Inviters create Invite_Tokens, each Invite_Token expires after 7 days and adds at most one account, and each trip has at most the Trip_Invite_Limit of Active_Invites.

### Requirement 15: Invitation Preview for Signed-Out Visitors

**User Story:** As a person who received an invitation link, I want to see which trip I am invited to and who invited me before I create an account, so that I know what I sign up for.

#### Acceptance Criteria

1. WHEN the App_Server receives `GET /api/invites/<token>/preview` for a Valid_Invite, THE App_Server SHALL respond with status 200 and a JSON body that contains exactly the trip title, destination, start date, end date, and inviter display name, whether or not the request carries a session.
2. THE App_Server SHALL leave the participant list, trip state, account identifiers, usernames, invite counts, and invite expiry out of the Invite_Preview response.
3. IF the Invite_Token of a preview request is malformed, unknown, expired, revoked, a Used_Invite, created by a deleted account, created by an account that is no longer an Inviter for the trip, or attached to a deleted trip, THEN THE App_Server SHALL respond with status 404 and the Invalid_Invite_Message, with the same status, body, and set of header names in every case.
4. THE App_Server SHALL count every preview request against an `invitePreview` limit of 60 requests per 15 minutes keyed on the Client_Address.
5. IF a Client_Address exceeds the `invitePreview` limit, THEN THE App_Server SHALL respond with status 429 without looking up the Invite_Token.
6. THE App_Server SHALL send `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on every preview response and on every `/invite/<token>` page response.
7. WHEN the App_Server answers a preview request, THE App_Server SHALL leave the Invite_Token and the trip unchanged.
8. IF `GET /api/invites/<token>` is requested without a session, THEN THE App_Server SHALL respond with status 401, as before this feature.
9. IF the Invite_Preview request of a signed-out visitor returns status 404, THEN THE App_Shell SHALL show the invalid-link page with a link to sign in instead of the account creation form.

### Requirement 16: Trip Members Can Invite

**User Story:** As a trip member, I want to invite friends to the trip myself, so that the trip owner does not have to create every link.

#### Acceptance Criteria

1. THE App_Server SHALL report the `canInvite` capability as true for a trip exactly when the account is an Inviter for that trip.
2. WHEN an Inviter requests a new Invite_Token for a trip, THE App_Server SHALL create the Invite_Token, write the existing `invite.create` audit entry, and respond with status 201, the Invite_ID, the Invite_Token, the invitation link path, and the expiry time.
3. IF an account that is not an Inviter requests a new Invite_Token for a trip, THEN THE App_Server SHALL respond with status 404 and the existing message 找不到這趟旅行。.
4. IF a trip already has Trip_Invite_Limit Active_Invites, THEN THE App_Server SHALL respond to a new Invite_Token request with status 409 and the existing trip limit message.
5. IF an Inviter who is not a Trip_Manager already holds Member_Invite_Limit Active_Invites for the trip, THEN THE App_Server SHALL respond to a new Invite_Token request from that Inviter with status 409 and a message that names the limit of 5.
6. THE App_Server SHALL count only Active_Invites toward the Trip_Invite_Limit and the Member_Invite_Limit.
7. WHEN the App_Server removes an account's Trip_Member row for a trip, THE App_Server SHALL revoke, in the same transaction, every Active_Invite that the account created for that trip.
8. WHEN an admin deletes an account, THE App_Server SHALL revoke, in the same transaction, every Active_Invite that the account created.
9. WHEN an admin changes an account from the admin role to the member role, THE App_Server SHALL revoke, in the same transaction, every Active_Invite that the account created for a trip where the account is neither the owner nor a Trip_Member.
10. WHILE the `canInvite` capability is true for the signed-in account on a trip page, THE App_Shell SHALL show the invite button.
11. WHEN an Inviter creates an Invite_Token on the trip page, THE App_Shell SHALL show the link with a statement that the link adds one person and expires after 7 days.

### Requirement 17: Single-Use Invitation Links

**User Story:** As a trip member, I want each invitation link to work for one person only, so that a forwarded or leaked link cannot let many strangers into the trip.

#### Acceptance Criteria

1. WHEN an Invite_Join adds an account to a trip through a Valid_Invite, THE App_Server SHALL mark the Invite_Token as a Used_Invite, recording the time and the joining account, in the same database transaction as the trip membership insert.
2. IF any step of an Invite_Join fails, THEN THE App_Server SHALL leave the Invite_Token unused and the trip membership unchanged.
3. IF an Invite_Join or Invite_Registration request names a Used_Invite and the requesting account is neither the trip owner nor a Trip_Member, THEN THE App_Server SHALL respond with status 404 and the Invalid_Invite_Message.
4. WHEN a signed-in account that is the trip owner or a Trip_Member opens or joins through an Invite_Token that is unexpired and unrevoked, used or unused, THE App_Server SHALL report that the account is already a member, return the trip ID for a join, and leave the Invite_Token and the trip unchanged.
5. WHEN two or more requests attempt to add accounts through the same Invite_Token, THE App_Server SHALL add at most one account through that Invite_Token.
6. THE App_Server SHALL apply the single-use rule in both Local_Mode and Published_Mode.
7. WHEN the App_Server opens an accounts database whose `invites` table lacks the `used_at` and `used_by` columns, THE App_Server SHALL add the columns, keep every existing row and value, and treat every existing Invite_Token as unused.

### Requirement 18: Per-Link Revoke

**User Story:** As the person who created an invitation link, I want to revoke the link before it is used, so that I can stop a link I sent to the wrong person.

#### Acceptance Criteria

1. WHEN the creator of an Active_Invite or a Trip_Manager of its trip sends `POST /api/trips/<tripId>/invites/<inviteId>/revoke` with the Invite_ID of an Active_Invite of that trip, THE App_Server SHALL mark the invite as revoked, write an `invite.revoke` audit entry, and respond with status 200.
2. IF an Inviter for the trip who is neither the creator nor a Trip_Manager sends a revoke request for an Active_Invite of the trip, THEN THE App_Server SHALL respond with status 403 and leave the invite unchanged.
3. IF the Invite_ID of a revoke request is malformed, unknown, attached to another trip, or names an invite that is used, expired, or revoked, THEN THE App_Server SHALL respond with status 404 and the Invalid_Invite_Message, and leave every invite unchanged.
4. IF the account of a revoke request is not an Inviter for the trip in the request path, THEN THE App_Server SHALL respond with status 404 and the existing message 找不到這趟旅行。.
5. IF a revoke request has no session, THEN THE App_Server SHALL respond with status 401.
6. THE App_Server SHALL apply the Mutating_Request Origin check to revoke requests.
7. THE App_Server SHALL identify the invite of a revoke request by its Invite_ID and trip ID only, without accepting an Invite_Token as the revoke target.

### Requirement 19: List of Open Invitation Links

**User Story:** As an Inviter, I want to see the trip's open invitation links that I may revoke, so that I can revoke a link later without having kept it, and free a slot when I reach a limit.

#### Acceptance Criteria

1. WHEN a Trip_Manager sends `GET /api/trips/<tripId>/invites`, THE App_Server SHALL respond with status 200 and an Invite_List that contains every Active_Invite of the trip.
2. WHEN an Inviter who is not a Trip_Manager sends `GET /api/trips/<tripId>/invites`, THE App_Server SHALL respond with status 200 and an Invite_List that contains exactly the Active_Invites of the trip that the requesting account created.
3. THE App_Server SHALL include in each Invite_List entry exactly the Invite_ID, the creator display name, the creation time, and the expiry time.
4. THE App_Server SHALL leave every Invite_Token, every token hash, and every account identifier and username out of the Invite_List response.
5. THE App_Server SHALL leave Used_Invites, expired invites, and revoked invites out of the Invite_List.
6. IF the account of an Invite_List request is not an Inviter for the trip, THEN THE App_Server SHALL respond with status 404 and the existing message 找不到這趟旅行。.
7. IF an Invite_List request has no session, THEN THE App_Server SHALL respond with status 401.
8. WHEN the App_Server creates an Invite_Token, THE App_Server SHALL assign the invite a new random Invite_ID.
9. WHEN the App_Server opens an accounts database whose `invites` table lacks the Invite_ID column, THE App_Server SHALL add the column, assign a new random Invite_ID to every existing row, keep every other value, and enforce that no two rows share an Invite_ID.
10. WHEN an Inviter opens the Invitation_Dialog, THE App_Shell SHALL load the Invite_List and show each entry with the creator display name, creation time, expiry time, and a 撤銷 control, together with a control that creates a new Invite_Token.
11. WHEN a revoke from the Invitation_Dialog succeeds, THE App_Shell SHALL reload the Invite_List and show the reloaded list.
12. WHILE the Invite_List is empty, THE App_Shell SHALL show the text 目前沒有可撤銷的邀請連結。 in the Invitation_Dialog.
13. IF creating an Invite_Token from the Invitation_Dialog returns status 409, THEN THE App_Shell SHALL show the limit message in the Invitation_Dialog and keep the Invite_List visible.

## Open Questions and Assumptions

- **Who can invite (decided):** Trip_Managers and every Trip_Member are Inviters (`canInvite = manage || isMember`). The Member_Invite_Limit of 5 applies only to Inviters who are not Trip_Managers. Reason: a member normally invites a few friends, and the limit keeps one member from filling the trip's 20 slots and blocking the owner. Owners and admins keep only the Trip_Invite_Limit, so the existing test that creates 20 owner invites still holds. The limit does not cap the total number of accounts that one account can bring in, because any signed-in account can create its own trip and become its owner.
- **Site-wide per-account cap (decided: none):** The operator decided that no site-wide cap on invitations or trip creation per account is needed. The per-trip Trip_Invite_Limit and Member_Invite_Limit are the only invitation limits.
- **Rights lost after creation (decided):** A Valid_Invite requires that the creator is still an Inviter when the link is used. This check covers every way of losing rights. Explicit revocation also runs on account deletion and admin demotion. The app has no "leave trip" or "remove member" action today: bound participants cannot be removed from trip state, and only account deletion removes a `trip_members` row. Requirement 16.7 applies to any such path added later.
- **Single-use and already-joined accounts (decided):** An account that is already in the trip does not consume a link and can reopen a link it used, so a reload after joining shows "already a member" instead of an invalid-link error. Only accounts outside the trip see the 404 for a Used_Invite.
- **Per-link revoke and open-link list (decided):** Included in this feature. The server stores only token hashes, so an Invite_Token is shown once at creation and cannot be shown again. Each invite gets a non-secret Invite_ID, the Invite_List shows Invite_IDs, and revoke works by Invite_ID only. The creation response also returns the Invite_ID, so the link just created is revoked through the same route as the list entries. No token-based revoke route is added: one route means one set of rules and tests. Trip_Managers see every Active_Invite of the trip, and other Inviters see only their own.
- **Invitation preview (decided):** `GET /api/invites/<token>/preview` is public and returns only the Invite_Preview fields. Anyone holding an unused link can see the trip title, destination, dates, and inviter display name. `GET /api/invites/<token>` keeps requiring sign-in.
- **Registration_Policy in Published_Mode (decided):** Public registration is locked. `CAMPING_REGISTRATION=open` with Published_Mode on is a startup error, and `closed` is accepted. Local_Mode keeps `open` and `closed` with default `open`.
- **Closed registration and rate limits:** A `POST /api/register` under `closed` returns 403 before the `register` limit is counted, because it does no work. Invite_Registration still counts against `register`.
- **Local_Mode hosts:** Local_Mode accepts every IP_Literal_Host because the README's Docker trusted-LAN flow uses `http://<host-LAN-IPv4>:5182`, and the LAN IP is not known at build time. DNS rebinding needs a hostname, so accepting IP literals does not reopen that attack. Local_Extra_Hosts covers LAN hostnames. Published_Mode does not use Local_Extra_Hosts because LAN devices reach the site through nginx with the Public_Hostname.
- **Interaction with the `security-hardening` spec:** That spec lists `/invite/{token}` as a Private_Page that must redirect signed-out visitors before showing invite content, and its Public_API list does not include the preview route. Both need an update in that spec to match Requirements 14.1 and 15.
