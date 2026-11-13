---
inclusion: auto
name: modern-web-guidance
description: Look up current web platform best practices (HTML, CSS, client-side JS, accessibility, performance, security, forms, UI components) before writing or changing frontend code. Not for backend, SQL, CI/CD, Docker, deploy scripts or tests.
---

# Modern Web Guidance

Source: https://github.com/GoogleChrome/modern-web-guidance (Chrome, Edge, Firefox and MDN teams). Code is Apache-2.0, guides are CC-BY 4.0.

Use it at the start of any task that adds or changes web UI, CSS layout or animation, or client-side JS (dialogs, popovers, forms and validation, dark mode, tables, scrolling, view transitions, Core Web Vitals, images, sanitization, passkeys, dates and timezones, built-in AI). Skip it for server/, migrations, ci/, deploy/ and test-only work.

## Workflow

1. Search with a short query (2 to 5 words) that names one capability or UI primitive. No framework, file or app names. Split compound tasks into separate searches. Turn intent into the primitive: "confirm before delete" becomes "confirm dialog".

   ```powershell
   npx.cmd -y modern-web-guidance@latest search "light dismiss dialog" --skill-version 2026_11_09-5bcc021b
   ```

   If the results are empty or unrelated, rephrase once with the HTML/CSS noun (dialog, popover, table, form). If still nothing matches, continue without a guide.

2. Retrieve the matching guide IDs, plus any broad guide that applies (html, css, forms, accessibility, performance, security). Several IDs can be comma-separated.

   ```powershell
   npx.cmd -y modern-web-guidance@latest retrieve "light-dismiss-a-dialog,dialog"
   ```

   Large output is saved to a temp file; read it in full with the file-reading tool.

3. Implement, then check the code against the guide: modern pattern applied, required fallbacks present, user request fully met.

4. In the reply that delivers the change, add a `### Modern Web Guidance` section: one short bullet per guide ID that shaped the code, saying what non-obvious choice or fallback it led to, with a short quote of the specific rule. If guides were checked but none applied, say so in one sentence. Never cite an ID or quote from memory; re-run search/retrieve if unsure.

## Browser support

- Baseline Widely available features need no fallback.
- Features not yet widely available must follow the guide's fallback advice, unless this project defines its own browser support policy.
- This project has no written browser support policy yet. Little Moments is used on mobile (iOS Safari and Android Chrome). If a guide's fallback looks heavy, ask the user whether to set a policy here.

## Modernizing existing code

Only when the user asks for a broad modernization or legacy audit with no specific feature named:

```powershell
npx.cmd -y modern-web-guidance@latest legacy-scan src --json
```

Check each finding against its keepWhen/dropWhen notes, drop false positives, report, and only edit if asked to modernize. legacy-scan covers about 20% of the guides.

## Notes

- Guides are vanilla HTML/CSS/JS. Adapt them to this codebase without dropping the modern feature.
- The CLI needs network access to npm. Search queries are sent to the tool; never put code, secrets or user data in a query.
- If offline, retry with `npx.cmd --offline`.