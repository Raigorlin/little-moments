# Publish behind nginx

This guide publishes the account version of **日子拾光** at `https://www.our-littlemoments.com`. nginx runs on the same server, terminates TLS, and proxies to the Bun app server, which keeps listening on `127.0.0.1:5173`. Devices on your LAN reach the site through the same nginx and the same hostname.

Publishing is switched on with `CAMPING_PUBLISHED=1`. Without it, the server runs in local mode and behaves as described in the [README](../README.md), including the Docker setup.

## What is published and what is not

The published site serves login, invitations, account homes, trips, expenses, and the admin dashboard.

These parts are **not available** when `CAMPING_PUBLISHED=1`:

- **The `/demo/` local planner.** `/demo` and `/demo/` return 404, the app shell shows the not-found page, and the service worker does not serve its cached shell for `/demo/` navigations. The shared `app.js` and chunk files stay available because account trip pages use them.
- **Web first-admin setup.** `/setup` and `/setup/` return 404, and `POST /api/setup` returns 404 with `找不到這個 API。`, whatever the Host, peer address, or forwarding headers. You create the first administrator on the server with `bun run create-admin`. Until you do, the site shows `網站尚未完成設定`.
- **Public sign-up.** `POST /api/register` returns 403 and the register page explains that a trip invitation is needed. New people join through trip invitation links (see [Registration and invitation links](#registration-and-invitation-links)).

## Settings

The server reads these environment variables at startup. An invalid value stops startup with `Configuration error: <message>` and exit code 1. The message names the setting.

| Variable | Local mode default | Published mode default | Example for `https://www.our-littlemoments.com` | Notes |
| --- | --- | --- | --- | --- |
| `CAMPING_PUBLISHED` | `0` (off) | n/a (this setting turns published mode on) | `1` | Accepted values: `1`, `0`, or unset. Cannot be combined with `CAMPING_DOCKER_LOCAL_ONLY=1`. |
| `CAMPING_PUBLIC_ORIGIN` | unset | required | `https://www.our-littlemoments.com` | Origin only: scheme, hostname, optional port. No path, query, fragment, or credentials. Must use `https:` in published mode. Mutating requests through nginx must carry this exact `Origin`. |
| `CAMPING_TRUSTED_PROXIES` | empty | `127.0.0.1,::1` | (unset) or `127.0.0.1,::1` | Comma-separated IP addresses whose `X-Forwarded-For` header is trusted. Setting it replaces the default list. |
| `CAMPING_LOCAL_EXTRA_HOSTS` | empty | must be unset | (unset) | Extra LAN hostnames accepted in local mode only, for example `camp.lan`. Setting it in published mode stops startup. |
| `CAMPING_ALLOW_NON_LOOPBACK_BIND` | `0` | `0` | `0` | Required to set `HOST` to an address that is not loopback. Keep it off behind nginx. |
| `CAMPING_REGISTRATION` | `open` | `closed` (fixed) | (unset) | `open` or `closed`. In published mode registration is always `closed`, and `CAMPING_REGISTRATION=open` stops startup. |
| `CAMPING_RECEIPT_AI_POLICY` | unset, so `all` | unset, so `all` | `admins` | `all`, `admins`, or `off`. Initial value only: it applies until an admin saves a value on the admin page. |
| `CAMPING_DB` | `data/accounts.sqlite` | `data/accounts.sqlite` | `/srv/little-moments/data/accounts.sqlite` | SQLite database path. Must not be inside a `dist` or `public` directory. Use the same value for the server and `create-admin`. |
| `CAMPING_DIST` | `dist` | `dist` | (unset) | Directory with the built static files, relative to the project directory. |
| `HOST` | `127.0.0.1` | `127.0.0.1` | `127.0.0.1` | Bind address. Keep loopback so the app port is never reachable from the network. |
| `PORT` | `5173` | `5173` | `5173` | Must match `proxy_pass` in the nginx config. |
| `CAMPING_OPENAI_MODEL_ID` | `gpt-6-luna` | `gpt-6-luna` | (unset) | Receipt AI model. `gpt-` followed by 1 to 80 letters, digits, `.`, `_`, or `-`. |
| `CAMPING_OPENAI_IMAGE_DETAIL` | `high` | `high` | (unset) or `low` | Image detail sent to OpenAI: `low`, `high`, or `auto`. `low` uses fewer input tokens. |
| `CAMPING_OPENAI_MAX_COMPLETION_TOKENS` | `6000` | `6000` | (unset) | Maximum completion tokens per receipt request. Integer from 1 to 16000. |
| `CAMPING_RECEIPT_AI_USER_LIMIT` | `10` | `10` | (unset) | Receipt AI requests per user per rolling 15 minutes. Integer from 1 to 100. |
| `CAMPING_RECEIPT_AI_DAILY_LIMIT` | `100` | `100` | (unset) | Receipt AI requests for the whole site per UTC day. Integer from 1 to 10000. |
| `CAMPING_RECEIPT_AI_MONTHLY_LIMIT` | `1000` | `1000` | (unset) | Receipt AI requests for the whole site per UTC month. Integer from 1 to 100000. The three limits must satisfy user limit ≤ daily limit ≤ monthly limit. |

The existing receipt AI settings (`CAMPING_OPENAI_API_KEY_FILE`, model, and daily limits) work the same in both modes. See the README section on receipt recognition.

When the server starts in published mode, it logs the public origin, the bind address, the registration policy, and the effective receipt AI policy, for example:

```text
Camping accounts ready: https://www.our-littlemoments.com (app listening on http://127.0.0.1:5173)
Registration: closed (trip invitation links only). Receipt AI policy: all (default).
```

If the database has no user yet, a third line tells you to run `bun run create-admin`. Secret values such as the OpenAI API key never appear in the log.

## Deployment steps

The examples assume a Linux server with systemd, the project in `/srv/little-moments`, a dedicated OS user `littlemoments`, and Bun 1.3 or later at `/usr/local/bin/bun`. Adjust paths to your server. Run `command -v bun` to find your Bun path.

### 1. Build

As the `littlemoments` user, in the project directory:

```sh
cd /srv/little-moments
bun install --frozen-lockfile
bun run build
```

Run the build again after every update, then restart the service.

### 2. Configure the environment

Create `/etc/little-moments.env`, owned by `root` with mode `0600`:

```ini
CAMPING_PUBLISHED=1
CAMPING_PUBLIC_ORIGIN=https://www.our-littlemoments.com
CAMPING_DB=/srv/little-moments/data/accounts.sqlite
HOST=127.0.0.1
PORT=5173
# Optional. Initial receipt AI policy until an admin saves one on the admin page.
# CAMPING_RECEIPT_AI_POLICY=admins
```

```sh
sudo chown root:root /etc/little-moments.env
sudo chmod 0600 /etc/little-moments.env
```

Do not set `CAMPING_REGISTRATION=open`, `CAMPING_LOCAL_EXTRA_HOSTS`, or `CAMPING_DOCKER_LOCAL_ONLY` here. Each of them stops startup in published mode.

### 3. Start the app server on 127.0.0.1:5173

Create `/etc/systemd/system/little-moments.service`:

```ini
[Unit]
Description=Little Moments account server
After=network.target

[Service]
Type=simple
User=littlemoments
Group=littlemoments
WorkingDirectory=/srv/little-moments
EnvironmentFile=/etc/little-moments.env
ExecStart=/usr/local/bin/bun scripts/serve.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Start it and check the log:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now little-moments
sudo journalctl -u little-moments -n 20 --no-pager
```

The log should start with `Camping accounts ready: https://www.our-littlemoments.com (app listening on http://127.0.0.1:5173)`. A `Configuration error:` line means a setting is wrong; fix it and restart.

### 4. Create the first administrator

Run `create-admin` as the same OS user and with the same `CAMPING_DB` as the service, so the account goes into the database the server uses and the file keeps the right owner:

```sh
cd /srv/little-moments
sudo -u littlemoments env CAMPING_DB=/srv/little-moments/data/accounts.sqlite \
  CAMPING_PUBLIC_ORIGIN=https://www.our-littlemoments.com \
  /usr/local/bin/bun run create-admin
```

The script asks for the username, display name, password, and password confirmation. The password is not shown while you type, and it is never read from arguments, environment variables, or piped input, so the command needs an interactive terminal. If the database already has accounts, the script stops without changing anything.

The service can keep running during this step. The server sees the new administrator on its next request. You can also do this step before you enable the nginx site; no SSH tunnel is needed.

### 5. Enable the nginx site

Get a certificate first (see [Certificates](#certificates)). Then save the [example nginx config](#example-nginx-config) as `/etc/nginx/conf.d/little-moments.conf`, and remove or disable any other site that uses `default_server` on ports 80 or 443 (for example the distribution's `sites-enabled/default`).

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Allow TCP 80 and 443 in the host firewall. Do not open port 5173. For example, with ufw:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 6. Verify login over HTTPS

1. Open `https://www.our-littlemoments.com/login` and sign in as the administrator.
2. In the browser developer tools, check that the `ggc_session` cookie has `Secure`, `HttpOnly`, and `SameSite=Strict`.
3. Open `/admin` and check the `網站設定` section.

Then run these checks from a machine outside the server. Replace `203.0.113.10` with the server's public address.

```sh
# HSTS is present on the site, and the page loads.
curl -sI https://www.our-littlemoments.com/login
#   HTTP/2 200
#   strict-transport-security: max-age=15552000

# HTTP redirects to HTTPS with 301 (www and apex).
curl -sI http://www.our-littlemoments.com/login
#   HTTP/1.1 301 Moved Permanently
#   Location: https://www.our-littlemoments.com/login
curl -sI http://our-littlemoments.com/login
#   Location: https://www.our-littlemoments.com/login

# HTTPS apex redirects to www with 301 and also sends HSTS.
curl -sI https://our-littlemoments.com/login
#   HTTP/2 301
#   location: https://www.our-littlemoments.com/login
#   strict-transport-security: max-age=15552000

# Unknown Host over HTTP: connection closed without a response.
curl -sI -H 'Host: unknown.example' http://203.0.113.10/
#   curl: (52) Empty reply from server

# Unknown name over HTTPS: TLS handshake refused.
curl -sI --resolve unknown.our-littlemoments.com:443:203.0.113.10 https://unknown.our-littlemoments.com/
#   curl: (35) ... alert unrecognized name (wording depends on the TLS library)

# Local planner and web setup are not published.
curl -s -o /dev/null -w '%{http_code}\n' https://www.our-littlemoments.com/demo/
#   404
curl -s -o /dev/null -w '%{http_code}\n' https://www.our-littlemoments.com/setup
#   404

# Public registration is locked.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.our-littlemoments.com/api/register \
  -H 'Origin: https://www.our-littlemoments.com' -H 'Content-Type: application/json' -d '{}'
#   403

# The app port is not reachable from the network (run from another machine).
curl -s --max-time 5 http://203.0.113.10:5173/ || echo "not reachable (expected)"
```

## Certificates

One certificate must cover both `our-littlemoments.com` (the apex) and `www.our-littlemoments.com`. The apex needs it because HTTPS requests for the apex are answered with a redirect, and the browser checks the certificate before it sees the redirect.

With certbot and the nginx plugin:

```sh
sudo certbot certonly --nginx -d our-littlemoments.com -d www.our-littlemoments.com
```

certbot stores the files under `/etc/letsencrypt/live/our-littlemoments.com/`, which the example config uses. If you use another tool or path, update `ssl_certificate` and `ssl_certificate_key` in both TLS blocks. Check that automatic renewal reloads nginx, for example with `sudo certbot renew --dry-run`.

## HSTS

The example config sends `Strict-Transport-Security: max-age=15552000` (180 days) on every HTTPS response for `www` and the apex. Browsers that see it use only HTTPS for that hostname for 180 days.

- **`includeSubDomains`** is left off. Add it only after every subdomain of `our-littlemoments.com` serves HTTPS with a valid certificate. Otherwise browsers refuse HTTP-only subdomains.
- **`preload`** is left off. It adds the domain to lists shipped inside browsers. Removal takes months and needs every browser release to catch up, so it is hard to undo. Consider it only when the HTTPS setup for the whole domain is final.

The app sets its own security headers (Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy`, and others), so nginx adds only HSTS.

## Future subdomains

Only `www` serves the app, and the apex redirects to it. A future subdomain, for example `photos.our-littlemoments.com`, gets its own nginx `server` block and must be added to a certificate. Until then, requests for unknown names reach the `default_server` blocks: HTTP gets `return 444` (connection closed), and HTTPS has its TLS handshake refused.

Do not add a new name to the app's `server_name`. The app accepts only the hostname in `CAMPING_PUBLIC_ORIGIN` and answers 403 for others.

## LAN access

LAN devices use the same address as everyone else, `https://www.our-littlemoments.com`, through nginx. The same certificate is valid because the hostname is the same. The app keeps listening only on `127.0.0.1:5173`, and there is no LAN allowlist in published mode.

For this to work, LAN devices must resolve `www.our-littlemoments.com` to the server's LAN IP address instead of the public address. The examples use the server at `192.168.1.10` and LAN subnets `192.168.1.0/24` and `10.20.1.0/24`. Choose one of these options:

- **Split DNS or a router DNS entry (preferred).** Add a local DNS record on your router or LAN DNS server so that every device in `192.168.1.0/24` and `10.20.1.0/24` gets the LAN address. Add the apex too, so the redirect also stays on the LAN. With dnsmasq, for example:

  ```ini
  host-record=www.our-littlemoments.com,192.168.1.10
  host-record=our-littlemoments.com,192.168.1.10
  ```

- **A hosts-file entry** on a single device (`/etc/hosts` on Linux and macOS, `C:\Windows\System32\drivers\etc\hosts` on Windows):

  ```text
  192.168.1.10 www.our-littlemoments.com
  192.168.1.10 our-littlemoments.com
  ```

- **Hairpin NAT** on the router also works without DNS changes, but nginx may then see the router's address for every LAN device. All LAN users then share one rate-limit bucket for login and registration, so split DNS is better.

Devices in `10.20.1.0/24` need a route to `192.168.1.10`, and the host firewall must allow TCP 80 and 443 from both subnets. Port 5173 is never opened, on the LAN or the internet.

## Registration and invitation links

Public sign-up is locked in published mode. New accounts come only from trip invitation links:

- Every trip member, the trip owner, and administrators can create invitation links from the trip page.
- Each link is single use: it adds at most one account to the trip. It expires 7 days after it is created.
- A link also stops working when its creator leaves the trip, loses admin rights without being in the trip, or is deleted.
- Anyone holding an unused link sees a preview of the trip (title, destination, dates, and the inviter's display name) and can create an account on the invitation page, which joins the trip in the same step. Share links privately.
- The invite dialog lists the trip's unused links under `尚未使用的邀請連結`. Owners and administrators see every unused link of the trip; other members see the links they created. Each entry has a `撤銷` button that revokes that link.
- A link is shown only once, right after it is created (`連結只會顯示這一次，請現在複製。`), because the server stores only a hash of it. If the link is lost, revoke it and create a new one.
- A member who is not the owner or an administrator can hold at most 5 unused links per trip, and a trip can hold at most 20 unused links. There is no site-wide limit per account.
- The invitation preview is rate-limited to 60 requests per 15 minutes per client address.

## Receipt AI policy

The receipt AI policy controls who can send receipt photos to OpenAI. The default is `all` in both modes.

| Value | Admin page label | Who can use receipt AI |
| --- | --- | --- |
| `all` | `所有可編輯旅行的帳號` | Any account that can edit the trip (the previous behavior) |
| `admins` | `只限管理員` | Administrators only |
| `off` | `關閉` | Nobody |

Change it on the admin page (`/admin`) in the `網站設定` section. The change applies to the next receipt request without a restart, is written to the audit history, and survives restarts. The section also shows where the current value comes from.

`CAMPING_RECEIPT_AI_POLICY` only supplies the value while no admin has saved one. After an admin saves a value, the stored value wins and changing the environment variable has no effect. The existing per-user and global daily limits apply under every policy that allows recognition.

## Backup and restore

The database is `data/accounts.sqlite` (or the path in `CAMPING_DB`) and runs in WAL mode, so recent changes may be in `accounts.sqlite-wal` next to it. Do not copy the database file alone while the server is running.

### Back up while the server is running

Run as the `littlemoments` user, which can read the database and its `-wal` and `-shm` files. Either command writes one consistent file that includes all committed WAL content, so the `-wal` and `-shm` files do not need to be copied:

```sh
sudo -u littlemoments mkdir -p -m 0700 /srv/backups
sudo -u littlemoments sqlite3 /srv/little-moments/data/accounts.sqlite \
  ".backup '/srv/backups/accounts-$(date +%F).sqlite'"
```

or

```sh
sudo -u littlemoments sqlite3 /srv/little-moments/data/accounts.sqlite \
  "VACUUM INTO '/srv/backups/accounts-$(date +%F).sqlite'"
```

`VACUUM INTO` fails if the target file already exists. Check a backup with `sqlite3 /srv/backups/accounts-YYYY-MM-DD.sqlite "PRAGMA integrity_check;"`, which prints `ok`.

Backups contain password hashes, sessions, and all trip data. Keep them private (mode `0600`, directory `0700`) and store a copy off the server.

### Restore

Restore with the server stopped:

```sh
sudo systemctl stop little-moments
cd /srv/little-moments/data
sudo -u littlemoments mkdir -p old
sudo -u littlemoments mv accounts.sqlite accounts.sqlite-wal accounts.sqlite-shm old/ 2>/dev/null
sudo cp /srv/backups/accounts-YYYY-MM-DD.sqlite accounts.sqlite
sudo chown littlemoments:littlemoments accounts.sqlite
sudo chmod 0600 accounts.sqlite
sudo systemctl start little-moments
```

The old `-wal` and `-shm` files must not stay next to the restored database, because SQLite would try to apply them to it. Moving them aside keeps them until you have confirmed the restore; delete `old/` afterwards.

### OpenAI API key

The key file `.secrets/openai_api_key` (or the path in `CAMPING_OPENAI_API_KEY_FILE`) is not in the database and is not part of these backups. Keep it owned by `littlemoments` with mode `0600` in a `0700` directory, and do not put it in a backup that others can read. After a server rebuild, create the file again from your OpenAI account instead of copying it around. The key is never served by the app, since only the `dist` directory is public.

## Example nginx config

Save as `/etc/nginx/conf.d/little-moments.conf`. It needs nginx 1.25.1 or later for `http2 on;`; on older versions, remove that line and use `listen 443 ssl http2;`. `ssl_reject_handshake` needs nginx 1.19.4 or later.

```nginx
# /etc/nginx/conf.d/little-moments.conf
# Requires nginx >= 1.25.1 for "http2 on;" (older versions: "listen 443 ssl http2;").

# Unknown hostnames over HTTP: close the connection.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

# Unknown hostnames over HTTPS: refuse the TLS handshake, then close.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;   # nginx >= 1.19.4; no certificate needed for this block
    return 444;
}

# HTTP for apex and www: permanent redirect to the public origin.
server {
    listen 80;
    listen [::]:80;
    server_name our-littlemoments.com www.our-littlemoments.com;
    return 301 https://www.our-littlemoments.com$request_uri;
}

# HTTPS apex: permanent redirect to www.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name our-littlemoments.com;

    ssl_certificate     /etc/letsencrypt/live/our-littlemoments.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/our-littlemoments.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=15552000" always;
    return 301 https://www.our-littlemoments.com$request_uri;
}

# HTTPS www: the application.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name www.our-littlemoments.com;

    ssl_certificate     /etc/letsencrypt/live/our-littlemoments.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/our-littlemoments.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:little_moments:10m;
    server_tokens off;

    # 180 days. Add includeSubDomains only when every subdomain serves HTTPS. Do not add preload yet.
    add_header Strict-Transport-Security "max-age=15552000" always;

    # Must not exceed the app limit of 4 MiB (maxRequestBodySize 4194304).
    client_max_body_size 4m;

    # Return 404 for any path with a dot-prefixed segment (.env, .git, ...), except /.well-known/.
    location ~ /\.(?!well-known/) { return 404; }

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;   # replace any client-supplied value
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  "";
        proxy_set_header X-Real-IP         "";
        proxy_set_header Forwarded         "";

        # Receipt AI requests can take up to 70 s on the app side.
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }
}
```

Notes on the config:

- **Forwarded headers.** `X-Forwarded-For $remote_addr` replaces any value the client sent, so the app receives exactly one address. The app trusts it only because the request comes from `127.0.0.1`, which is in `CAMPING_TRUSTED_PROXIES`. If you use `$proxy_add_x_forwarded_for` instead, the app still picks the right-most address that is not a trusted proxy, so spoofed entries on the left are ignored.
- **No `X-Real-IP`.** The app does not read `X-Real-IP`, `X-Forwarded-Host`, or `Forwarded`. The config clears them as an extra safeguard. The app also ignores `X-Forwarded-Proto` for origin and cookie decisions; nginx sends it only for logs and future use.
- **No WebSocket settings.** The app uses plain HTTP requests only, so `Upgrade` and `Connection` headers are not needed.
- **Body size.** `client_max_body_size 4m` matches the app's 4 MiB request limit, so nginx rejects larger uploads before they reach the app.
- **Timeout.** `proxy_read_timeout 90s` is longer than the app's 70-second receipt AI request timeout.
- **HSTS with `always`.** `always` makes nginx add the header to every response, including error and redirect responses. The apex block sends it too.
- **Host.** `proxy_set_header Host $host` passes `www.our-littlemoments.com` to the app, which accepts only the hostname of `CAMPING_PUBLIC_ORIGIN`.
