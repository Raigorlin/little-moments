// schedule-tab-css-parity: stylesheet rule-parity test.
// Property 1: Stylesheet rule parity.
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRules, checkParity, describeEntry } from './schedule-parity/support/css-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'crates/web');
const BUN_STYLES = join(ROOT, 'src/styles.css');
const RUST_STYLES = join(WEB, 'styles/styles.css');

// Rust_Stylesheets: the hrefs of the Trunk `data-trunk rel="css"` links in index.html, in link order.
function rustStylesheetPaths() {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const hrefs = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\bdata-trunk\b/i.test(tag) || !/\brel\s*=\s*["']css["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) hrefs.push(href[1]);
  }
  return hrefs;
}

function rustSheets() {
  return rustStylesheetPaths().flatMap((href) => {
    const file = join(WEB, href);
    return parseRules(readFileSync(file, 'utf8'), file.slice(ROOT.length + 1));
  });
}

describe('Property 1: Stylesheet rule parity', () => {
  test('index.html links styles.css and accounts.css before scene-motion-layout.css', () => {
    const hrefs = rustStylesheetPaths();
    expect(hrefs.slice(0, 3)).toEqual(['styles/styles.css', 'styles/accounts.css', 'styles/scene-motion-layout.css']);
  });

  test('crates/web/styles/styles.css is byte-identical to src/styles.css', () => {
    const bun = readFileSync(BUN_STYLES);
    const rust = readFileSync(RUST_STYLES);
    const same = Buffer.compare(bun, rust) === 0;
    if (!same) {
      let i = 0;
      while (i < bun.length && i < rust.length && bun[i] === rust[i]) i++;
      console.error(`styles.css differs from src/styles.css at byte ${i} (sizes ${rust.length} vs ${bun.length})`);
    }
    expect(same).toBe(true);
  });

  test('checkParity reports no missing, different or out-of-order rules', () => {
    const report = checkParity(readFileSync(BUN_STYLES, 'utf8'), rustSheets());
    if (report.length > 0) console.error(report.map(describeEntry).join('\n'));
    expect(report.map(describeEntry)).toEqual([]);
  });
});
