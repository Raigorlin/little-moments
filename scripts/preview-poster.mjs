// Dev helper: render the Itinerary_Poster for Example_Trip to a static page and a PNG (Chrome headless).
//   bun scripts/preview-poster.mjs [width] [out.png]
import { writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { posterHtml } from '../src/itinerary-poster.js';
import { mapLink } from '../src/maps.js';
import { exampleTrip } from '../tests/fixtures/example-trip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const width = Number(process.argv[2]) || 1200;
const out = resolve(process.argv[3] || resolve(root, 'previews', `poster-${width}.png`));
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const html = `<!doctype html><html lang="zh-Hant" data-scene-motion="static"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./src/styles.css"><link rel="stylesheet" href="./src/accounts.css"><link rel="stylesheet" href="./src/scene-motion.css"><link rel="stylesheet" href="./src/itinerary.css"></head>
<body><main id="main" style="max-width:${width}px;margin:0 auto;padding:16px">
${posterHtml(exampleTrip(), { icon: () => '', mapLink, canEdit: false })}</main></body></html>`;
const page = resolve(root, '.preview-poster.html');
writeFileSync(page, html);
const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},3000`,
  '--virtual-time-budget=4000', `--screenshot=${out}`, 'file:///' + page.replace(/\\/g, '/')], { encoding: 'utf8' });
rmSync(page, { force: true });
console.log(r.status === 0 ? `wrote ${out}` : r.stderr);

