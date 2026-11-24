// rust-schedule-studio: the Rust schedule tab embeds the Bun storybook studio styles unchanged.
// crates/web/styles/storybook-studio.css (inside the studio Shadow Root) and storybook-host.css (linked from index.html)
// must stay byte-identical to the Bun files, and index.html must ship the Patrick Hand font the host sheet loads.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'crates/web');
const COPIES = [
  ['src/storybook/style.css', 'crates/web/styles/storybook-studio.css'],
  ['src/storybook-host.css', 'crates/web/styles/storybook-host.css']
];
// The <link> tags of index.html, comments removed.
function links() {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    trunk: /\bdata-trunk\b/i.test(tag),
    rel: tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1],
    href: tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1],
    target: tag.match(/\bdata-target-path\s*=\s*["']([^"']+)["']/i)?.[1]
  }));
}
describe('storybook studio styles', () => {
  for (const [bunFile, rustFile] of COPIES) {
    test(`${rustFile} is byte-identical to ${bunFile}`, () => {
      const bun = readFileSync(join(ROOT, bunFile));
      const rust = readFileSync(join(ROOT, rustFile));
      const same = Buffer.compare(bun, rust) === 0;
      if (!same) {
        let i = 0;
        while (i < bun.length && i < rust.length && bun[i] === rust[i]) i++;
        console.error(`${rustFile} differs from ${bunFile} at byte ${i} (sizes ${rust.length} vs ${bun.length})`);
      }
      expect(same).toBe(true);
    });
  }
  test('index.html links storybook-host.css but not the shadow-root sheet', () => {
    const css = links().filter(l => l.trunk && l.rel === 'css').map(l => l.href);
    expect(css).toContain('styles/storybook-host.css');
    expect(css).not.toContain('styles/storybook-studio.css');
  });
  test('index.html copies assets/storybook/fonts to /assets/storybook/fonts', () => {
    const copy = links().find(l => l.trunk && l.rel === 'copy-dir' && l.href === '../../assets/storybook/fonts');
    expect(copy?.target).toBe('assets/storybook/fonts');
    expect(readFileSync(join(WEB, 'styles/storybook-host.css'), 'utf8')).toContain('/assets/storybook/fonts/PatrickHand-32c1a2bb.woff2');
    expect(readFileSync(join(ROOT, 'assets/storybook/fonts/PatrickHand-32c1a2bb.woff2')).length).toBeGreaterThan(0);
  });
});
