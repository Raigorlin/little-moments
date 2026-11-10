// 安全測試套件的自足執行器（Requirement 7.6、10.10、10.11；design.md Components §8）。
//
//   bun scripts/security-suite.mjs
//
// 對每一組設定：建立拋棄式 DATABASE（tests/support/e2e-db.mjs）→ scripts/migrate.mjs → 啟動 scripts/serve.mjs →
// 以 tests/security/run.mjs 執行 tests/security/*.sec.js → 停止伺服器並 DROP DATABASE（成功、失敗或 SIGINT／SIGTERM 皆然）。
//
//   loopback  CAMPING_BIND_ADDRESS=127.0.0.1、預設 Allowed_Hosts，經 http://127.0.0.1:<port> 存取。
//   lan       Req 10.10：Allowed_Hosts 含非 loopback Host 名稱（預設 lm-test.lan），整個套件經該 Host 名稱送出請求
//             （CAMPING_SECURITY_REQUIRE_LAN_HOST=1）；TCP 實際連到 127.0.0.1（CAMPING_SECURITY_CONNECT_ADDRESS）。
//             另設 CAMPING_TRUSTED_PROXIES=<proxy 來源>，以 127.0.0.2 為來源驗證 X-Forwarded-Proto 與 Secure Cookie。
//
// 綁定位址：lan 組的 CAMPING_BIND_ADDRESS 取自 CAMPING_SECURITY_LAN_BIND，預設 127.0.0.1。
//   - 開發機請維持預設：綁定 0.0.0.0 會把測試伺服器暴露給整個區域網路。
//   - CI 在隔離的 `docker network create --internal` 網路內執行時設 CAMPING_SECURITY_LAN_BIND=0.0.0.0，
//     此時伺服器啟用 Setup_Token，本執行器產生一次性設定碼同時交給伺服器（CAMPING_SETUP_TOKEN）與套件
//     （CAMPING_SECURITY_SETUP_TOKEN），套件會先驗證缺少／錯誤／偽造轉送標頭的設定請求被拒（TC-SEC-102）。
//   - 綁定 loopback 時伺服器不啟用 Setup_Token（Req 9.2），該行為由 tests/setup-guard.test.js 等單元測試涵蓋；
//     且非 loopback Host 無法完成首次設定，因此本執行器先以 loopback Host 建立合成管理員，
//     再以 CAMPING_SECURITY_ADMIN_USER／_PASSWORD 交給套件。
//
// 必要環境變數：CAMPING_TEST_DATABASE_*（管理連線，帳號需 CREATEDB；見 tests/support/pg.js）、CHROME_PATH（XSS 檢查）。
// 選用：CAMPING_SECURITY_GROUPS（逗號分隔，預設 loopback,lan）、CAMPING_SECURITY_LAN_HOST、CAMPING_SECURITY_LAN_BIND、
//       CAMPING_SECURITY_LAN_PROXY_SOURCE（預設 127.0.0.2；設為空字串則不驗證 Trusted_Proxies）。
// 輸出：reports/security-junit-<group>.xml 與合併後的 reports/security-junit.xml（供 ci/policy/normalize.mjs
//       --tool security-suite 使用）；伺服器日誌 reports/security-server-<group>.log。
// 結束碼：0 全部通過；1 測試失敗或執行錯誤；2 設定錯誤。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackAddress } from '../server/config.js';
import { readTestDatabaseConfig, TestDatabaseConfigError } from '../tests/support/pg.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bun = process.execPath;
const reports = resolve(root, 'reports');

// ---------- 設定檢查（在建立任何資料庫或程序之前） ----------
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
try { readTestDatabaseConfig(process.env); } catch (e) { fail(e instanceof TestDatabaseConfigError ? e.message : '測試 Database 設定無效'); }
const chromePath = process.env.CHROME_PATH;
if (!chromePath || !fs.existsSync(chromePath)) fail('安全測試環境變數無效 CHROME_PATH: unset or not found（XSS 檢查需要 Chromium）');
if (!fs.existsSync(resolve(root, 'dist/index.html'))) fail('找不到 dist/index.html，請先執行 bun run build');

const lanHost = (process.env.CAMPING_SECURITY_LAN_HOST || 'lm-test.lan').toLowerCase();
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(lanHost) || lanHost === 'localhost' || isIP(lanHost)) {
  fail('安全測試環境變數無效 CAMPING_SECURITY_LAN_HOST: must be a non-loopback host name');
}
const lanBind = process.env.CAMPING_SECURITY_LAN_BIND || '127.0.0.1';
if (isIP(lanBind) === 0) fail('安全測試環境變數無效 CAMPING_SECURITY_LAN_BIND: must be an IP address literal');
const proxySource = process.env.CAMPING_SECURITY_LAN_PROXY_SOURCE ?? '127.0.0.2';
if (proxySource !== '' && isIP(proxySource) === 0) fail('安全測試環境變數無效 CAMPING_SECURITY_LAN_PROXY_SOURCE: must be an IP address literal or empty');
if (!isLoopbackAddress(lanBind)) console.warn(`警告：lan 組綁定非 loopback 位址 ${lanBind}；只應在隔離的 CI 網路中使用。`);

const GROUPS = {
  loopback: { port: 5191, bind: '127.0.0.1', base: port => `http://127.0.0.1:${port}`, env: {}, suiteEnv: {} },
  lan: {
    port: 5192, bind: lanBind, base: port => `http://${lanHost}:${port}`,
    env: { CAMPING_ALLOWED_HOSTS: `${lanHost},127.0.0.1`, ...(proxySource ? { CAMPING_TRUSTED_PROXIES: proxySource } : {}) },
    suiteEnv: { CAMPING_SECURITY_REQUIRE_LAN_HOST: '1', CAMPING_SECURITY_CONNECT_ADDRESS: '127.0.0.1', ...(proxySource ? { CAMPING_SECURITY_PROXY_SOURCE: proxySource } : {}) },
  },
};
const selected = (process.env.CAMPING_SECURITY_GROUPS || 'loopback,lan').split(',').map(s => s.trim()).filter(Boolean);
for (const g of selected) if (!GROUPS[g]) fail(`安全測試環境變數無效 CAMPING_SECURITY_GROUPS: unknown group ${JSON.stringify(g)}`);

// 子程序基礎環境：移除任何可能指向真實環境的資料庫、網路、設定碼、AI 與套件設定。
// 測試資料庫的管理憑證（CAMPING_TEST_DATABASE_*）只交給 e2e-db.mjs，不進入伺服器或套件程序。
const STRIP = /^(CAMPING_DATABASE_|CAMPING_TEST_DATABASE_|CAMPING_DB$|CAMPING_BIND_ADDRESS$|CAMPING_ALLOWED_HOSTS$|CAMPING_TRUSTED_PROXIES$|CAMPING_SETUP_TOKEN$|CAMPING_BEDROCK_|CAMPING_SECURITY_)/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k)));
const dbAdminEnv = { ...baseEnv, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CAMPING_TEST_DATABASE_'))) };
const noAi = { CAMPING_BEDROCK_REGION: '', CAMPING_BEDROCK_MODEL_ID: '', CAMPING_BEDROCK_API_KEY: '' };

fs.mkdirSync(reports, { recursive: true });

// ---------- 子程序與清理 ----------
let current = { dbName: null, server: null, log: null };
let cleaning = null;

function runBun(args, { env = baseEnv, capture = false, log } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(bun, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => { if (capture) stdout += d; else log?.write(d); });
    child.stderr.on('data', d => log?.write(d));
    child.once('error', reject);
    child.once('exit', code => done({ code, stdout }));
  });
}

async function cleanup() {
  const { server, dbName, log } = current;
  current = { dbName: null, server: null, log: null };
  if (server && server.exitCode === null) {
    const exited = new Promise(r => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (dbName) {
    const { code } = await runBun([resolve(root, 'tests/support/e2e-db.mjs'), 'drop', dbName], { env: dbAdminEnv, log });
    if (code !== 0) { console.error(`無法刪除安全測試資料庫 ${dbName}（結束碼 ${code}），請手動 DROP DATABASE`); process.exitCode ||= 1; }
  }
  if (log) await new Promise(r => log.end(r));
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    console.error(`收到 ${signal}，清理安全測試環境`);
    cleaning ||= cleanup();
    await cleaning;
    process.exit(130);
  });
}

/** 以 loopback Host 建立合成管理員（lan 組、loopback 綁定時使用）。 */
function seedAdmin(port) {
  const admin = { username: `sec-admin-${randomBytes(4).toString('hex')}`, displayName: '安全測試管理員', password: `Sec-${randomBytes(18).toString('base64url')}` };
  const body = Buffer.from(JSON.stringify(admin));
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/setup', agent: false, timeout: 15000,
      headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(body.length) } }, res => {
      res.resume();
      res.once('end', () => (res.statusCode === 200 || res.statusCode === 201 ? done(admin) : reject(new Error(`以 loopback Host 建立合成管理員失敗（${res.statusCode}）`))));
    });
    req.once('timeout', () => req.destroy(new Error('建立合成管理員逾時')));
    req.once('error', reject);
    req.end(body);
  });
}

async function runGroup(name) {
  const group = GROUPS[name];
  const log = fs.createWriteStream(resolve(reports, `security-server-${name}.log`), { flags: 'w' });
  current.log = log;
  const created = await runBun([resolve(root, 'tests/support/e2e-db.mjs'), 'create'], { env: dbAdminEnv, capture: true, log });
  const dbName = created.stdout.trim();
  if (created.code !== 0 || !/^lm_e2e_[0-9a-f]{16}$/.test(dbName)) throw new Error(`無法建立安全測試資料庫（結束碼 ${created.code}，詳見 reports/security-server-${name}.log）`);
  current.dbName = dbName;

  const e = process.env;
  const setupToken = isLoopbackAddress(group.bind) ? null : randomBytes(32).toString('base64url');
  const serverEnv = {
    ...baseEnv, ...noAi, ...group.env,
    PORT: String(group.port), CAMPING_BIND_ADDRESS: group.bind,
    CAMPING_DATABASE_HOST: e.CAMPING_TEST_DATABASE_HOST, CAMPING_DATABASE_NAME: dbName,
    CAMPING_DATABASE_USER: e.CAMPING_TEST_DATABASE_USER, CAMPING_DATABASE_PASSWORD: e.CAMPING_TEST_DATABASE_PASSWORD,
    ...(e.CAMPING_TEST_DATABASE_PORT ? { CAMPING_DATABASE_PORT: e.CAMPING_TEST_DATABASE_PORT } : {}),
    ...(e.CAMPING_TEST_DATABASE_SSLMODE ? { CAMPING_DATABASE_SSLMODE: e.CAMPING_TEST_DATABASE_SSLMODE } : {}),
    ...(setupToken ? { CAMPING_SETUP_TOKEN: setupToken } : {}),
  };
  const migrated = await runBun([resolve(root, 'scripts/migrate.mjs')], { env: serverEnv, log });
  if (migrated.code !== 0) throw new Error(`遷移失敗（結束碼 ${migrated.code}，詳見 reports/security-server-${name}.log）`);

  const server = spawn(bun, [resolve(root, 'scripts/serve.mjs')], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  current.server = server;
  await new Promise((done, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('伺服器 60 秒內未就緒')), 60000);
    server.stdout.on('data', d => { log.write(d); buffer += d; if (buffer.includes('Camping accounts ready:')) { clearTimeout(timer); buffer = ''; done(); } else if (buffer.length > 65536) buffer = buffer.slice(-1024); });
    server.stderr.on('data', d => log.write(d));
    server.once('error', err => { clearTimeout(timer); reject(err); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`安全測試伺服器結束（${code}，詳見 reports/security-server-${name}.log）`)); });
  });

  const suiteEnv = { ...baseEnv, ...group.suiteEnv, CHROME_PATH: chromePath, CAMPING_SECURITY_BASE_URL: group.base(group.port) };
  if (setupToken) suiteEnv.CAMPING_SECURITY_SETUP_TOKEN = setupToken;
  else if (name === 'lan') {
    const admin = await seedAdmin(group.port);
    suiteEnv.CAMPING_SECURITY_ADMIN_USER = admin.username;
    suiteEnv.CAMPING_SECURITY_ADMIN_PASSWORD = admin.password;
  }
  console.log(`\n=== 安全測試組 ${name}：${suiteEnv.CAMPING_SECURITY_BASE_URL}（bind ${group.bind}，拋棄式資料庫）===`);
  const junit = `reports/security-junit-${name}.xml`;
  const code = await new Promise((done, reject) => {
    const child = spawn(bun, [resolve(root, 'tests/security/run.mjs'), '--junit', junit], { cwd: root, env: suiteEnv, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', done);
  });
  return { code, junit: resolve(root, junit) };
}

/** 合併各組 JUnit：取出每份報告的 <testsuite> 元素，名稱加上組別前綴，包進單一 <testsuites>。 */
function mergeJunit(results) {
  const suites = [];
  for (const { name, junit } of results) {
    if (!fs.existsSync(junit)) continue;
    const xml = fs.readFileSync(junit, 'utf8');
    const open = /<testsuites\b[^>]*>/.exec(xml);
    const close = xml.lastIndexOf('</testsuites>');
    if (!open || close < 0) continue;
    suites.push(xml.slice(open.index + open[0].length, close).replace(/<testsuite name="/g, `<testsuite name="[${name}] `));
  }
  const out = resolve(reports, 'security-junit.xml');
  fs.writeFileSync(out, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="security-suite">${suites.join('\n')}</testsuites>\n`);
  return out;
}

const results = [];
try {
  for (const name of selected) {
    try {
      const r = await runGroup(name);
      results.push({ name, ...r });
      if (r.code !== 0) process.exitCode = 1;
    } finally {
      cleaning = cleanup();
      await cleaning;
      cleaning = null;
    }
  }
} catch (err) {
  console.error(err?.message ?? err);
  process.exitCode ||= 1;
}
const merged = mergeJunit(results);
console.log(`\nJUnit：${merged}；各組結果：${results.map(r => `${r.name}=${r.code === 0 ? 'pass' : 'fail'}`).join(', ') || '無'}`);
