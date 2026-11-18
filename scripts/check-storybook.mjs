// Local-only storybook integration QA. Serves the isolated build under production CSP.
// There is no database or account service here; run separately from account E2E.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHttpHandler } from '../server/http.js';

const root = resolve(import.meta.dir, '..');
const browser = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dist = resolve(root, 'dist');
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Isolated frontend build missing; run bun run build first.');
if (!existsSync(browser)) throw new Error('Chrome not found; configure CHROME_PATH for local QA.');
const node = 'C:/Program Files/nodejs/node.exe';
if (!existsSync(node)) throw new Error('Local Node not found.');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch: createHttpHandler({root: dist, accounts: {async handle(){return null;}}, health: () => true})
});
const base = `http://127.0.0.1:${server.port}`;
console.log(`Isolated storybook QA server: ${base} (/demo and synthetic account API; no database).`);
try {
  const args = process.argv.slice(2);
  const test = Bun.spawn({
    cmd: [node, resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', resolve(root, 'playwright.config.js'),
      'tests/storybook-integration.e2e.js', 'tests/storybook-account.e2e.js', ...args],
    cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    env: {...process.env, CHROME_PATH: browser, CAMPING_BASE_URL: base}
  });
  const code = await test.exited;
  if (code !== 0) process.exitCode = code;
} finally { server.stop(true); }
