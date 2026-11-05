# 日子拾光 · LITTLE MOMENTS

**日子拾光** is a Traditional Chinese camping and trip planner. Plan an itinerary, meals, shopping, shared gear, vehicles, and trip expenses; invite an account to collaborate; and switch to a personal departure checklist when it is time to go. The repository includes an account-backed **Expo / React Native** iOS and Android client alongside the web app.

The app has two modes:

| Mode | Open | Data and availability |
| --- | --- | --- |
| Account mode | `/setup`, `/login`, or `/register` | Trips and accounts are stored in the server's SQLite database. Sign in to collaborate from other devices on your trusted network. Account mode needs a running server and is not available offline. |
| Local planner | `/demo/` | Starts with a blank trip and stores it in this browser only. It can be used offline after the app has loaded. It is separate from account trips and is not shared with other devices. |

This repository contains source code, not personal trip data or a hosted website. It is independent of the original inspiration site and does not connect to it.

## Features

- **Accounts and trips:** Create an administrator on first run, register member accounts, create multiple planning or completed trips, choose an illustrated cover, and keep each trip's history separate.
- **Invitations and permissions:** Invite companions to a trip. Trip creators and administrators can manage membership and delete trip content; collaborators can plan within their permissions. Administrators can manage accounts, trips, invitations, and review the audit history.
- **Trip overview:** See the trip dates, destination, companions, and departure countdown alongside trip progress.
- **Itinerary:** Plan dated and timed stops, add notes and map links, mark stops complete, and filter by vehicle. Specify which people or cars participate. Each vehicle can have its own departure time and meeting place.
- **Meals and shopping:** Use meal templates and ingredient shortcuts, assign cooks, and organize meals by date. Ingredients sync into categorized shopping lists without discarding manually managed items. Assign shoppers, update quantities, filter items, and check off purchases.
- **Gear and departure checklist:** Separate personal and shared equipment, start from common camping presets, assign shared gear to a companion, and track each person's packing progress.
- **Crew and vehicles:** Manage companion names and roles, driver/passenger assignments, seat counts, and each car's departure arrangements.
- **Shared expense ledger:** In account mode, record trip expenses and repayments, review balances, and export ledger records separately from the trip handbook.
- **Receipt assistance:** In account mode, selecting a receipt photo sends it automatically to the configured OpenAI model (default `gpt-6-luna`, GPT-6 Luna). Review and confirm every suggested item before saving. There is no automatic local-OCR fallback.
- **Mobile and accessibility:** Responsive layouts, horizontally scrollable trip sections and date selection, mobile swipe actions for editing and deleting, a dark theme, keyboard focus indicators, and reduced-motion support.
- **Illustrations and presentation:** Original SVG trip and meal illustrations, trip cover choices, a daily note, and optional scene animation controls.
- **Trip export and print:** Export or print a trip handbook from its settings. Handbook export is separate from expense-ledger export and a full database backup.
- **React Native mobile app (early migration):** A native iOS/Android client with secure session storage, account sign-in, trip list, mobile swipe-to-open cards, itinerary, meals, shopping, gear and crew views. It can update itinerary completion, shopping check-offs, and the signed-in member's packing status. More trip-management features are still being migrated; keep using the web app for full feature coverage.

## Getting started

### Requirements

- [Bun](https://bun.sh/) 1.3 or later (the Docker image uses Bun 1.3.14).
- Docker Desktop with Docker Compose for container deployment.
- Native Node.js and Chrome/Chromium only when running the browser end-to-end test harness.

### Run locally

From the project directory:

```powershell
bun install --frozen-lockfile
bun run build
$env:PORT = '5174'
bun run start
```

Open [http://127.0.0.1:5174/setup](http://127.0.0.1:5174/setup) to create the first administrator. The server defaults to port `5173` if `PORT` is not set; its default bind address is `127.0.0.1` (loopback only).

The first administrator must be created from the server computer using a loopback address. There is **no default account or password**. Account names are 3–32 characters, start with a lowercase letter, and use lowercase letters, numbers, or hyphens. Passwords must be at least 12 characters.

Once setup is complete:

- Sign in at `/login`.
- Create a member account at `/register`.
- Open the account homepage at `/<account-name>/home`.
- Open the administrator dashboard at `/admin`.
- Use `/demo/` to open the independent local planner.

The first administrator can invite members or manage accounts from the admin dashboard. To share a trip, create or open a trip, use **Invite companions**, and share the generated invitation link with the intended person. A member must have an account and sign in to collaborate.

## Expo / React Native mobile app

The `mobile/` folder is an actual Expo React Native app for iOS and Android; it is not the web planner in a native-looking browser. It talks to the same account API and SQLite database as the existing web app. The web app remains available during the gradual mobile migration.

### Requirements

- Bun 1.4 or later to install packages and run the Expo CLI.
- Node.js supported by the installed Expo SDK for some native development/build workflows (Expo SDK 58 requires Node 22.13.x or 24.3+).
- Android Studio and Android SDK for a local Android build/emulator. Local iOS builds require macOS and Xcode; on Windows, use an iOS device with Expo Go or a cloud build service.

Install dependencies and start Expo from the repository root:

```powershell
bun install --cwd mobile
bun run --cwd mobile start
```

In the app, enter the address of the running account server. For an Android emulator, use the computer's reachable LAN address or emulator host address; for a physical phone, use the server computer's LAN IPv4 address, for example `http://192.168.1.20:5182`. Both devices must be on the same trusted private network and the Windows Private-profile firewall rule described above must permit the app port. `127.0.0.1` on a physical phone means the phone itself, not the server computer. The default `http://127.0.0.1:5182` is intended for a local emulator or a server running on the same device.

The server validates request Origin headers; the mobile client sends the configured server origin for mutations and keeps the session cookie in the device's secure storage. Changing the server address clears the stored session. This is a private-LAN development setup over HTTP, not production mobile networking; do not expose the server publicly. For distribution beyond a trusted LAN, use HTTPS and a reviewed deployment configuration.

Useful validation commands:

```powershell
bun run --cwd mobile typecheck
bunx --cwd mobile expo export --platform android
bunx --cwd mobile expo export --platform ios
```

## Plan a trip

1. **Create or open a handbook.** From your account homepage, create a trip, enter its name and dates, select a cover, and add an optional destination, description, and notes. Local planner mode opens directly into its blank handbook.
2. **Plan the itinerary.** In **Schedule**, select a day and add a stop with a time, location, type, notes, and participants. Locations can open in a map app. Add vehicles and departure arrangements in **Companions & vehicles**; vehicle filters let you inspect each car's stops separately.
3. **Plan meals.** In **Meals**, add meals by date and mealtime. Apply a template or add ingredient shortcuts, assign a cook, and include notes. Linked ingredients are added to the shopping list automatically; editing meal ingredients updates the linked items.
4. **Organize shopping.** In **Shopping**, assign who buys each item, adjust its quantity or category, filter the list, and mark items as purchased. Use **Hide purchased** to focus on what remains.
5. **Divide the gear.** In **Gear**, add personal or shared items. Personal gear is tracked per companion; shared gear can be assigned to an owner. Check the unassigned count before departure.
6. **Check the crew and vehicles.** In **Companions & vehicles**, add companions, roles, drivers, passengers, and vehicle capacity. Set each vehicle's separate departure time and location.
7. **Record expenses (account mode).** Open **Expenses**, add expenses and repayments, then review the balances. Expense ledgers are stored by the server, separately from handbook data.
8. **Get ready to leave.** Open **Departure mode** to see your packing progress, your assigned personal and shared gear, and the next unfinished stop. Mark items packed and confirm when you are ready.
9. **Keep or share the handbook.** From **Trip settings**, export a JSON handbook backup or print the current handbook. Account trips remain available to trip members after signing in.

On a phone, swipe a supported list row left to reveal edit and delete actions; swipe right to close it. The on-screen action control is also available. Deletion continues to follow the account's permissions and confirmation prompts.

## Expense splitting and receipt recognition

The **Expenses** tab uses the authenticated account-mode ledger. The local browser planner does not provide the server-backed expense ledger.

### Add and settle expenses

- Record who paid, the amount, category, date, and participating companions.
- Add repayments separately from purchases.
- Review the resulting balances and export the expense records when needed.
- Only users with the appropriate trip permissions can edit or remove ledger entries.

### Scan a receipt

1. Configure an OpenAI API key on the server as described below.
2. Open **Expenses** for a trip and choose the receipt-photo option.
3. **Selecting a photo automatically sends a prepared copy to OpenAI** using the configured model (default `gpt-6-luna`). Do not select a photo if you do not want it uploaded. API use may incur charges and is subject to OpenAI's API data policies.
4. Review the suggested store, date, items, categories, and amounts against the receipt. Correct anything uncertain and confirm the items before saving them to the ledger.
5. If recognition is unavailable or incorrect, enter the receipt text or expenses manually. The app does not silently switch to local OCR.

JPEG, PNG, and WebP receipt photos are supported. Images over 10 MB or 20 megapixels are rejected; the prepared image is resized for the request. The app does not save receipt photos or raw OCR text. It stores only the expense entries you confirm and a file fingerprint used to help prevent duplicate receipt entry. Re-encoding removes EXIF/GPS metadata before upload.

## Configure OpenAI receipt recognition

By default, the server reads the API key from `.secrets/openai_api_key`. Create this file locally and store the key in it:

```powershell
New-Item -ItemType Directory -Force .secrets
notepad .secrets\openai_api_key
```

Keep the key private. `.secrets/` is ignored by Git and excluded from the Docker build context. In Docker, Compose mounts the key read-only at `/run/secrets/openai_api_key`.

The Compose file requires the secret file to exist even if you do not plan to use receipt recognition. To run Docker without AI, create an empty file instead; receipt recognition will remain disabled:

```powershell
New-Item -ItemType Directory -Force .secrets
New-Item -ItemType File -Force .secrets\openai_api_key
```

Optional server environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CAMPING_OPENAI_API_KEY_FILE` | `.secrets/openai_api_key` locally; `/run/secrets/openai_api_key` in Docker | Path to the server-side API key file. |
| `CAMPING_OPENAI_MODEL_ID` | `gpt-6-luna` | OpenAI model ID used for image-capable receipt recognition. |

Restart the local server after changing the key. For Docker, recreate the app container:

```powershell
docker compose up -d --force-recreate
```

Receipt recognition is disabled until a valid key is configured. The key is read by the server and is never sent to the browser.

## Run with Docker

From the project directory, create the API key file (or an empty file to disable AI) as described above, then build and start:

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

Open [http://127.0.0.1:5182/setup](http://127.0.0.1:5182/setup) **on the host computer** and create the administrator before enabling LAN access. Compose publishes the app on port `5182` on all host interfaces by default.

### Optional trusted-LAN access

This is a private-network setup, not public hosting. First complete administrator setup on the host. Find its LAN IPv4 address with `ipconfig`, then allow the application port only from local-subnet devices on the Windows **Private** network profile. Run PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Little Moments LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5182 -RemoteAddress LocalSubnet -Profile Private
```

Other devices on that trusted network can then visit `http://<host-LAN-IPv4>:5182` and sign in. Do not configure router port forwarding or expose the service to the public internet; this setup does not provide TLS. Remove the firewall rule later with:

```powershell
Remove-NetFirewallRule -DisplayName "Little Moments LAN"
```

### Docker settings and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `CAMPING_HOST_PORT` | `5182` | Host port published by Docker. Update the firewall rule if changed. |
| `CAMPING_BIND_ADDRESS` | `0.0.0.0` | Host interface to bind; the default requires an appropriate firewall restriction. |
| `CAMPING_DATA_VOLUME` | `little-moments-initial-setup-data` | Existing or new named Docker volume used for the SQLite database. |

Stop the service with `docker compose down`; the named volume and accounts are preserved. Start again with `docker compose up -d`. Switching to a different `CAMPING_DATA_VOLUME` does not delete the previous volume. To permanently remove the active Compose volume and its database, run `docker compose down --volumes`; this is destructive and cannot be undone without a separate backup.

## Data, privacy, and security

- **Local planner:** Trip data is stored in this browser's local storage. It is not uploaded or synchronized, and is separate from account trips.
- **Account mode:** Accounts, trips, and expense ledgers are stored in the server's private SQLite database (`data/accounts.sqlite` by default; `/app/data/accounts.sqlite` in Docker). Account API responses are not cached for offline use.
- **Credentials and sessions:** There is no default password. Passwords are stored as salted scrypt hashes. Sessions use HttpOnly cookies and expire; changing or losing the server database invalidates server-side data and sessions.
- **Access control:** Mutating requests require a matching Origin and the appropriate account/trip permissions. Deletion is restricted to trip creators or administrators.
- **Receipt privacy:** Selecting a receipt photo for AI recognition sends it to OpenAI. The app does not persist the image or raw OCR text, but does save confirmed ledger entries and a receipt fingerprint. Review OpenAI's API data policies before use.
- **API key security:** The `.secrets/openai_api_key` file is plain text on your computer, not encrypted storage. Do not commit, sync, or share it.
- **Network security:** The built-in server binds to loopback by default outside Docker. LAN use should remain behind the Windows local-subnet firewall rule. This configuration is not suitable for public hosting.
- **Separate exports:** Trip handbook export, expense-ledger export, and a full SQLite database backup are different. A handbook export is not a full account/database backup.
- **Database backups:** Keep backups private and outside GitHub. Do not copy a live SQLite database file on its own; use SQLite's backup API or stop all writers and back up the complete database safely.

## Configuration for local development

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5173` | Local server port. |
| `HOST` | `127.0.0.1` | Local server bind address. |
| `CAMPING_DB` | `data/accounts.sqlite` | Private SQLite database path. |
| `CAMPING_DIST` | `dist` | Built static application directory. |

## Build and tests

Install dependencies and build the static application:

```powershell
bun install --frozen-lockfile
bun run build
```

Run the unit and isolated API tests:

```powershell
bun test
```

The repository also includes Playwright browser tests. `playwright.config.js` expects Chrome at the default Windows path or at `CHROME_PATH`, and defaults to `http://127.0.0.1:5173`. The isolated harness starts a separate server on port `5181` with an **in-memory database** and synthetic test accounts:

```powershell
$env:CAMPING_BUN = (Get-Command bun).Source
$env:CAMPING_DIST = 'dist'
node scripts/check-accounts.mjs
```

Use native Node.js to run the harness (not Bun). Set `CHROME_PATH` if Chrome/Chromium is installed elsewhere. Do not point browser tests at a real server or private database. Test credentials are synthetic and are not application defaults.

## GitHub and hosting

This repository stores source code, not a hosted website or personal data. GitHub Pages cannot run the Bun/SQLite backend. Public hosting requires a separate deployment design, HTTPS, and a security review.

## Third-party assets and licensing

Self-hosted Huninn fonts retain their SIL Open Font License files in `assets/fonts/`. Font provenance is recorded in `assets/fonts/SOURCE.txt`. Tesseract and bundled OCR runtime files include their license notices.

No project-wide open-source license has been selected. Existing third-party license notices remain applicable.
