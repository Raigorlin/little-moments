# 日子拾光 · LITTLE MOMENTS

A local camping planner with a Traditional Chinese interface, original SVG illustrations, account-specific trips and shared planning.

This source snapshot matches the application release served locally on port **5174**. It contains no real accounts, trips, receipt images, database, backups or credentials. It is independent of the original inspiration site and does not connect to it.

## Features

- Separate accounts, trip histories, invitations and administrator controls.
- Itinerary stops for everyone, one vehicle or multiple vehicles, with per-car filtering and independent arrivals.
- A countdown centered on the camping illustration; restrained animation with pause and reduced-motion support.
- Meal templates, automatic illustrations and ingredient-to-shopping synchronization. The meal-image selector is hidden; previews and saved image choices are preserved.
- Personal and shared gear with common camping presets.
- New Taiwan dollar expense splitting and repayment records.
- OpenAI GPT-6 Luna receipt recognition by default. Selecting a receipt image uploads it automatically; recognition failures do not fall back to local OCR. Results always require review before saving.
- Light/dark themes, responsive layouts and a browser-only local planner that starts with an empty trip.

## Run locally

Requires **Bun 1.3+**. This snapshot was built and tested with Bun **1.3.14**. Run commands from this folder.

```sh
bun install --frozen-lockfile
bun run build
```

Start on port 5174 in PowerShell:

```powershell
$env:PORT = '5174'
bun run start
```

Or in bash:

```sh
PORT=5174 bun run start
```

AI receipt recognition reads the API key from `.secrets/openai_api_key` by default. Replace its placeholder with your OpenAI API key to enable it, then restart the server. Selecting a receipt image sends it to OpenAI automatically and may incur API charges; the image is not saved by the app. Results are drafts and require review before saving. `CAMPING_OPENAI_API_KEY_FILE` can point to a different key file; `CAMPING_OPENAI_MODEL_ID` optionally selects a GPT model with image support (default `gpt-6-luna`).

Open `http://127.0.0.1:5174/setup` and create your own administrator account. There is **no default admin password**. Later logins use `/login`, registrations use `/register`, and the administrator dashboard is `/admin`.

Without `PORT`, the server defaults to 5173. Use an unused port if another copy is already running. `CAMPING_DIST` changes the build directory; `CAMPING_DB` changes the private SQLite path.

## Run with Docker

Requires Docker Desktop with Docker Compose. From this folder, build and start the app in PowerShell:

```powershell
notepad .secrets\openai_api_key
# Replace the placeholder with your OpenAI API key, then save and close Notepad.
docker compose up --build -d
docker compose logs -f
```

Open `http://127.0.0.1:5182/setup` on the host computer and create your administrator account before enabling network access. The Compose configuration publishes the app on all host interfaces; restrict inbound access with the Windows Firewall rule below so only devices on the private local subnet can connect. To find the host's LAN address, run `ipconfig` and use the IPv4 address for the Wi-Fi or Ethernet adapter (for example, `http://192.168.1.114:5182`). Other devices on the same trusted private network can then sign in and share trips. This is a private-LAN setup, not public hosting: do not configure router port forwarding, use a public/untrusted network, or allow inbound access from the internet.

On Windows, run PowerShell as Administrator to allow the app port only from local-subnet devices on Private network profiles:

```powershell
New-NetFirewallRule -DisplayName "Little Moments LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5182 -RemoteAddress LocalSubnet -Profile Private
```

If you change `CAMPING_HOST_PORT`, update `-LocalPort` to match. To remove the rule later, run `Remove-NetFirewallRule -DisplayName "Little Moments LAN"` in elevated PowerShell. `CAMPING_BIND_ADDRESS` can optionally bind to one specific host IPv4 address instead of all interfaces; the default is `0.0.0.0`, so keep the firewall restriction in place.

The app mounts the ignored key file read-only into the container and stores SQLite data in a persistent Docker volume named `camping-data` (by default, `little-moments-initial-setup-data`). Set `CAMPING_DATA_VOLUME` before running Compose to use a different existing volume. Switching volumes does not delete the previous volume; set `CAMPING_DATA_VOLUME` to its name to use its accounts and trips again. If port 5182 is already in use, set `CAMPING_HOST_PORT` to an available port and open that port instead. Recreate the container after changing the key with `docker compose up -d --force-recreate`. Stop `docker compose logs -f` with `Ctrl+C` to leave the logs, then run `docker compose down` to stop the app; the volume and account data are preserved. Start it again with `docker compose up -d`.

To permanently delete the database and other volume data, run `docker compose down --volumes`.

## Data and security

- The app is reachable to other devices only when the host firewall permits it. The first-admin setup requires a loopback host and must be completed from the host machine before LAN users sign in. Limit access to a trusted private network; this configuration does not provide TLS and is not suitable for public hosting.
- SQLite is stored at `data/accounts.sqlite`, outside the static build. This folder must remain private and is ignored by Git.
- Do not copy an active SQLite database file by itself: use SQLite's backup API, or stop all writers before making a complete backup. Keep database backups outside GitHub.
- Sessions use HttpOnly cookies; passwords use salted scrypt hashes. Mutating requests require an exact matching Origin and appropriate account/trip permissions.
- Account API responses are never cached for offline use. The local planner at `/demo/#/trip` starts with a blank trip, uses separate browser-local storage and supports offline use. Existing browser-saved trips are preserved; use **清除旅行資料** in the settings to start over.
- Receipt images and raw OCR text are not persisted by the app. OCR assets are served locally and loaded on demand. Local OCR stays in the browser.
- OpenAI receipt recognition is available only when an API key is configured. Selecting a receipt image automatically sends the prepared image to OpenAI; this can incur API charges and is subject to OpenAI API data policies. Recognition failures do not fall back to local OCR. Results are drafts and require human review. The API key is read server-side from `.secrets/openai_api_key` and is never sent to the browser.
- The `.secrets/openai_api_key` file is plain text on your computer, not encrypted storage. Keep it private; do not sync or share it. It and the entire `.secrets/` directory are ignored by Git and excluded from Docker build context. Docker Compose mounts the key file read-only.
- Homepage JSON-import controls remain hidden; implementation is retained. Trip export and expense export are separate; neither replaces a full database backup.

## Tests

Build first, then run the unit and isolated API tests:

```sh
bun test ./tests
```

Browser tests require native Node.js plus Chrome/Chromium. The harness starts a separate server on **5181** with an **in-memory database**, creates synthetic test accounts, and closes the server afterwards. Do not point browser tests at a real server or private database.

PowerShell example (Chrome installed in its default Windows location):

```powershell
$env:CAMPING_BUN = (Get-Command bun).Source
$env:CAMPING_DIST = 'dist'
node scripts/check-accounts.mjs
```

Bash example (set `CHROME_PATH` to the installed Chrome/Chromium executable):

```sh
CAMPING_BUN="$(command -v bun)" CAMPING_DIST=dist node scripts/check-accounts.mjs
```

`CHROME_PATH` overrides the default Windows Chrome path. Run the harness with native Node, not Bun. Test fixture passwords are synthetic and used only in isolated test databases; they are not application defaults.

## GitHub scope

This repository stores **source code**, not a hosted website or a copy of your personal data. **GitHub Pages cannot run the Bun/SQLite backend.** Public hosting would require a separate deployment design, HTTPS and security review.

Generated builds, dependencies, screenshots, logs, backups and database files are excluded. Docker builds the static app and keeps persistent account data in a separate named volume.

## Third-party assets

Self-hosted Huninn fonts retain their SIL Open Font License files in `assets/fonts/`. Font provenance is in `assets/fonts/SOURCE.txt`. The build copies Tesseract and bundled component license notices with the OCR runtime files.

No project-wide open-source license has been selected. Existing third-party license notices remain applicable.
