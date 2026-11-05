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
- Browser-local receipt OCR with Traditional Chinese and English models. Recognition always requires review before saving.
- Light/dark themes, responsive layouts and a separate fictional browser-only demo.

## Run locally

Requires **Bun 1.3+**. This snapshot was built and tested with Bun **1.3.14**. Run commands from this folder.

```sh
bun install --frozen-lockfile
bun run build
```

Start on port 5174 in PowerShell:

```powershell
$env:PORT = '5174'
$env:CAMPING_BEDROCK_REGION = ''
$env:CAMPING_BEDROCK_MODEL_ID = ''
$env:CAMPING_BEDROCK_API_KEY = ''
bun run start
```

Or in bash:

```sh
PORT=5174 CAMPING_BEDROCK_REGION='' CAMPING_BEDROCK_MODEL_ID='' CAMPING_BEDROCK_API_KEY='' bun run start
```

Open `http://127.0.0.1:5174/setup` and create your own administrator account. There is **no default admin password**. Later logins use `/login`, registrations use `/register`, and the administrator dashboard is `/admin`.

Without `PORT`, the server defaults to 5173. Use an unused port if another copy is already running. `CAMPING_DIST` changes the build directory; `CAMPING_DB` changes the private SQLite path.

## Data and security

- The server binds only to `127.0.0.1` and accepts loopback hostnames. First-admin setup also requires a loopback client. Do not remove these protections to expose this prototype publicly.
- SQLite is stored at `data/accounts.sqlite`, outside the static build. This folder must remain private and is ignored by Git.
- Do not copy an active SQLite database file by itself: use SQLite's backup API, or stop all writers before making a complete backup. Keep database backups outside GitHub.
- Sessions use HttpOnly cookies; passwords use salted scrypt hashes. Mutating requests require an exact matching Origin and appropriate account/trip permissions.
- Account API responses are never cached for offline use. The fictional demo at `/demo/#/trip` has separate browser-local storage and offline support.
- Receipt images and raw OCR text are not persisted by the app. OCR assets are served locally and loaded on demand.
- Cloud AI receipt recognition is **paused and disabled by default**. Retained prototype modules are not connected to the receipt UI. Leave all `CAMPING_BEDROCK_*` settings empty; no credentials are provided.
- Homepage JSON-import controls remain hidden; implementation is retained. Trip export and expense export are separate; neither replaces a full database backup.

## Tests

Build first, then run the unit and isolated API tests:

```sh
bun test tests/*.test.js
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

Generated builds, dependencies, screenshots, logs, backups and database files are excluded. No Docker configuration is included.

## Third-party assets

Self-hosted Huninn fonts retain their SIL Open Font License files in `assets/fonts/`. Font provenance is in `assets/fonts/SOURCE.txt`. The build copies Tesseract and bundled component license notices with the OCR runtime files.

No project-wide open-source license has been selected. Existing third-party license notices remain applicable.
