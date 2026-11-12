// README 檢查（Requirement 24.2、24.9）。
// 1. 環境變數表（<!-- env-table:start --> … <!-- env-table:end -->）列出 parseConfig 讀取的每個變數，
//    且預設值、必填與未設定時行為與 server/config.js 實作一致。
// 2. README 不含任何符合秘密模式的字串；範例值只用佔位符。
// 3. deploy/README.md 的「首次部署與 smoke-bot」與 README 帳號維運章節（Requirement 27.25、27.26）。
import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseConfig, DEFAULT_BIND_ADDRESS, DEFAULT_PORT, DEFAULT_ALLOWED_HOSTS, DEFAULT_DATABASE_PORT, DEFAULT_DATABASE_SSLMODE,
  AI_ENV, AI_COST_DEFAULTS,
} from '../server/config.js';
import { createReceiptAi } from '../server/receipt-ai.js';
import { resolveRegistrationPolicy } from '../server/settings.js';
import { findLeaks } from '../ci/scrub.mjs';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const readme = read('../README.md');
const configSource = read('../server/config.js');
const serveSource = read('../scripts/serve.mjs');

// ---------------------------------------------------------------------------
// 表格解析

/** 以 `|` 切欄，忽略行內程式碼（反引號）內的 `|`。 */
function splitRow(line) {
  const cells = [];
  let cur = '', inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const ch of body) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 解析 env-table 區塊為 [{names, purpose, required, defaultValue, behavior}]。defaultValue：字串、null（—）或 ''（空）。 */
function parseEnvTable(text) {
  const start = text.indexOf('<!-- env-table:start -->');
  const end = text.indexOf('<!-- env-table:end -->');
  if (start < 0 || end < start) return null;
  const lines = text.slice(start, end).split('\n').filter(l => l.trim().startsWith('|'));
  const [header, sep, ...rows] = lines;
  if (!header || !sep || !/^\|?\s*-+/.test(sep.trim())) return null;
  return {
    header: splitRow(header),
    rows: rows.map(line => {
      const [name, purpose, required, def, behavior] = splitRow(line);
      const names = [...name.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(m => m[1]);
      let defaultValue;
      if (def === '—') defaultValue = null;
      else if (def === '空') defaultValue = '';
      else {
        const m = /^`([^`]*)`$/.exec(def);
        defaultValue = m ? m[1] : def; // 非程式碼文字（例如「腳本上一層的 `migrations/`」）原樣保留
      }
      return { names, purpose, required, defaultValue, behavior };
    }),
  };
}

const table = parseEnvTable(readme);
const rowOf = name => table.rows.find(r => r.names.includes(name));

// 最小有效設定：loopback 綁定、必要 Database 變數以佔位符填入。
const REQUIRED_DB = ['CAMPING_DATABASE_HOST', 'CAMPING_DATABASE_NAME', 'CAMPING_DATABASE_USER', 'CAMPING_DATABASE_PASSWORD'];
const minimalEnv = () => Object.fromEntries(REQUIRED_DB.map(n => [n, `placeholder-${n.toLowerCase()}`]));

describe('env-table 結構', () => {
  test('區塊存在且欄位為 名稱 | 用途 | 必填 | 預設值 | 未設定時', () => {
    expect(table).not.toBeNull();
    expect(table.header).toEqual(['名稱', '用途', '必填', '預設值', '未設定時']);
    for (const row of table.rows) {
      expect(row.names.length).toBeGreaterThan(0);
      expect(row.purpose).not.toBe('');
      expect(row.behavior).not.toBe('');
    }
  });

  test('parseConfig 讀取的每個變數都列在表中', () => {
    const body = configSource.slice(configSource.indexOf('export function parseConfig'));
    const used = new Set([
      ...[...body.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]),
      ...[...configSource.matchAll(/'(CAMPING_[A-Z0-9_]+)'/g)].map(m => m[1]),
    ]);
    expect(used.has('PORT')).toBe(true);
    expect(used.has('CAMPING_DATABASE_PASSWORD')).toBe(true);
    const listed = new Set(table.rows.flatMap(r => r.names));
    for (const name of used) expect({ name, listed: listed.has(name) }).toEqual({ name, listed: true });
    // CAMPING_DB 不是設定欄位（Req 11.1），不應出現在表中。
    expect(listed.has('CAMPING_DB')).toBe(false);
  });

  test('App 讀取的其他變數（CAMPING_DIST、CAMPING_MIGRATIONS_DIR、CAMPING_OPENAI_API_KEY／_FILE）也列在表中', () => {
    for (const name of ['CAMPING_DIST', 'CAMPING_MIGRATIONS_DIR', 'CAMPING_OPENAI_API_KEY', 'CAMPING_OPENAI_API_KEY_FILE']) {
      expect(rowOf(name)).toBeDefined();
    }
  });
});

describe('預設值與 parseConfig 一致（Req 24.2）', () => {
  const result = parseConfig(minimalEnv());

  test('最小設定可以通過', () => {
    expect(result.ok).toBe(true);
  });

  test('Bind_Address 預設 127.0.0.1', () => {
    expect(rowOf('CAMPING_BIND_ADDRESS').defaultValue).toBe('127.0.0.1');
    expect(result.config.bindAddress).toBe(rowOf('CAMPING_BIND_ADDRESS').defaultValue);
    expect(DEFAULT_BIND_ADDRESS).toBe('127.0.0.1');
  });

  test('Allowed_Hosts 預設 127.0.0.1、localhost、[::1]', () => {
    const def = rowOf('CAMPING_ALLOWED_HOSTS').defaultValue;
    expect(def).toBe(DEFAULT_ALLOWED_HOSTS.join(','));
    expect(def.split(',')).toEqual(['127.0.0.1', 'localhost', '[::1]']);
    expect(result.config.allowedHosts).toEqual(def.split(','));
  });

  test('PORT、CAMPING_DATABASE_PORT、CAMPING_DATABASE_SSLMODE 預設值', () => {
    expect(rowOf('PORT').defaultValue).toBe(String(DEFAULT_PORT));
    expect(result.config.port).toBe(Number(rowOf('PORT').defaultValue));
    expect(rowOf('CAMPING_DATABASE_PORT').defaultValue).toBe(String(DEFAULT_DATABASE_PORT));
    expect(result.config.database.port).toBe(Number(rowOf('CAMPING_DATABASE_PORT').defaultValue));
    expect(rowOf('CAMPING_DATABASE_SSLMODE').defaultValue).toBe(DEFAULT_DATABASE_SSLMODE);
    expect(result.config.database.sslmode).toBe(rowOf('CAMPING_DATABASE_SSLMODE').defaultValue);
  });

  test('Trusted_Proxies 預設為空；Setup_Token 無預設且 loopback 時不啟用', () => {
    expect(rowOf('CAMPING_TRUSTED_PROXIES').defaultValue).toBe('');
    expect(result.config.trustedProxies).toEqual([]);
    expect(rowOf('CAMPING_SETUP_TOKEN').defaultValue).toBeNull();
    expect(result.config.setupTokenMode).toBe('disabled');
    expect(result.config.setupToken).toBeNull();
  });

  test('CAMPING_DIST 預設 dist（scripts/serve.mjs）', () => {
    expect(rowOf('CAMPING_DIST').defaultValue).toBe('dist');
    expect(serveSource).toContain(`process.env.CAMPING_DIST||'${rowOf('CAMPING_DIST').defaultValue}'`);
  });

  test('CAMPING_OPENAI_API_KEY 預設為空，沒有金鑰時停用', () => {
    expect(rowOf('CAMPING_OPENAI_API_KEY').defaultValue).toBe('');
    // 指向不存在的金鑰檔，避免讀到開發機上的 .secrets/openai_api_key。
    const missing = fileURLToPath(new URL('./.no-such-dir/openai_api_key', import.meta.url));
    expect(createReceiptAi({ env: { CAMPING_OPENAI_API_KEY_FILE: missing } }).status.enabled).toBe(false);
  });

  test('必要 Database 變數標示為必填、無預設值，缺少時錯誤指出該變數', () => {
    for (const name of REQUIRED_DB) {
      expect(rowOf(name).required).toBe('是');
      expect(rowOf(name).defaultValue).toBeNull();
      const env = minimalEnv();
      delete env[name];
      const r = parseConfig(env);
      expect(r.ok).toBe(false);
      expect(r.errors.map(e => e.name)).toEqual([name]);
    }
    // 全部缺少時逐一列出。
    expect(parseConfig({}).errors.map(e => e.name).sort()).toEqual([...REQUIRED_DB].sort());
  });

  test('表中標示「否」的變數都不是必要 Database 變數', () => {
    for (const row of table.rows.filter(r => r.required === '否')) {
      for (const name of row.names) expect(REQUIRED_DB).not.toContain(name);
    }
  });

  test('非 loopback Bind_Address 未設定 Allowed_Hosts 時拒絕啟動（Req 8.4）', () => {
    const row = rowOf('CAMPING_ALLOWED_HOSTS');
    expect(row.required).toContain('Bind_Address 不是 loopback 時必填');
    expect(row.behavior).toContain('非 loopback Bind_Address：拒絕啟動');
    const r = parseConfig({ ...minimalEnv(), CAMPING_BIND_ADDRESS: '0.0.0.0' });
    expect(r.ok).toBe(false);
    expect(r.errors.map(e => e.name)).toEqual(['CAMPING_ALLOWED_HOSTS']);
    // 設定 Allowed_Hosts 後即可啟動，且 Setup_Token 自動產生（README 所述）。
    const ok = parseConfig({ ...minimalEnv(), CAMPING_BIND_ADDRESS: '0.0.0.0', CAMPING_ALLOWED_HOSTS: 'camp.lan' });
    expect(ok.ok).toBe(true);
    expect(ok.config.setupTokenMode).toBe('generated');
    expect(rowOf('CAMPING_SETUP_TOKEN').behavior).toContain('自動產生');
  });

  test('註冊政策、收據 AI 政策與 AI_Cost_Config 的預設值與 parseConfig 一致；無效值拒絕啟動且只指出該變數', () => {
    // 註冊政策的初始值未設定時為 null；沒有儲存值時由 server/settings.js 解析為 open（Req 26.1、26.18）。
    expect(result.config.registrationPolicySeed).toBeNull();
    expect(rowOf('CAMPING_REGISTRATION').defaultValue).toBe(resolveRegistrationPolicy(null, result.config.registrationPolicySeed).value);
    const registrationRow = rowOf('CAMPING_REGISTRATION');
    for (const text of ['Registration_Seed', '`closed`', '`compose.yaml`', '`/admin`']) expect(registrationRow.purpose + registrationRow.behavior).toContain(text);
    // 收據 AI 政策沒有初始值（null）；未儲存設定時由 server/settings.js 解析為 all。
    expect(rowOf('CAMPING_RECEIPT_AI_POLICY').defaultValue).toBeNull();
    expect(result.config.receiptAiPolicySeed).toBeNull();
    for (const [field, name] of Object.entries(AI_ENV)) {
      expect({ name, def: rowOf(name).defaultValue }).toEqual({ name, def: String(AI_COST_DEFAULTS[field]) });
      expect(result.config.aiCost[field]).toBe(AI_COST_DEFAULTS[field]);
      // 空字串視同未設定（Compose 以 ${VAR:-} 傳入空字串）。
      expect(parseConfig({ ...minimalEnv(), [name]: '' }).config.aiCost[field]).toBe(AI_COST_DEFAULTS[field]);
    }
    const invalid = {
      CAMPING_REGISTRATION: 'invite-only', CAMPING_RECEIPT_AI_POLICY: 'everyone',
      [AI_ENV.modelId]: 'not-gpt', [AI_ENV.imageDetail]: 'medium', [AI_ENV.maxCompletionTokens]: '0',
      [AI_ENV.perUser]: '0', [AI_ENV.daily]: '0', [AI_ENV.monthly]: '0',
    };
    for (const [name, value] of Object.entries(invalid)) {
      const row = rowOf(name);
      expect({ name, required: row.required }).toEqual({ name, required: '否' });
      expect(row.behavior).toContain('拒絕啟動');
      const r = parseConfig({ ...minimalEnv(), [name]: value });
      expect({ name, errors: r.ok ? [] : r.errors.map(e => e.name) }).toEqual({ name, errors: [name] });
    }
  });
});

describe('表格解析器（property）', () => {
  // **Validates: Requirements 24.2**
  test('任意列內容都能還原名稱、必填與預設值', () => {
    const name = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,20}$/);
    const text = fc.stringMatching(/^[^|`\n]{1,20}$/).map(s => s.trim() || 'x');
    const def = fc.oneof(fc.constant(null), fc.constant(''), fc.stringMatching(/^[^`\n]{1,20}$/));
    fc.assert(fc.property(fc.uniqueArray(name, { minLength: 1, maxLength: 3 }), text, text, def, text, (names, purpose, required, d, behavior) => {
      const cell = d === null ? '—' : d === '' ? '空' : `\`${d}\``;
      const md = ['<!-- env-table:start -->', '| 名稱 | 用途 | 必填 | 預設值 | 未設定時 |', '|---|---|---|---|---|',
        `| ${names.map(n => `\`${n}\``).join('、')} | ${purpose} | ${required} | ${cell} | ${behavior} |`, '<!-- env-table:end -->'].join('\n');
      const parsed = parseEnvTable(md);
      expect(parsed.rows.length).toBe(1);
      expect(parsed.rows[0].names).toEqual(names);
      expect(parsed.rows[0].defaultValue).toBe(d);
      expect(parsed.rows[0].required).toBe(required);
    }), { numRuns: 200 });
  });
});

describe('README 不含秘密（Req 24.9）', () => {
  test('沒有私鑰、Token、AWS 金鑰或 bcrypt 雜湊', () => {
    expect(readme).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(readme).not.toMatch(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/);
    expect(readme).not.toMatch(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
    expect(readme).not.toMatch(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/);
    expect(readme).not.toMatch(/\bxox[abpr]-[A-Za-z0-9-]{10,}/);
  });

  test('沒有長的十六進位或 Base64 字串（全 0 範例除外）', () => {
    for (const m of readme.matchAll(/[0-9a-f]{32,}/gi)) expect(m[0]).toMatch(/^0+$/);
    for (const m of readme.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) expect(m[0]).toMatch(/^([a-z/]+|0+)$/);
  });

  test('URL 不含帳密（userinfo 只能是佔位符）', () => {
    const placeholder = /^(\$\{?[A-Za-z_]+\}?|<[^>]+>|\*+)$/;
    for (const m of readme.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s/@`'"]+)@/gi)) {
      for (const part of m[1].split(':')) expect(part).toMatch(placeholder);
    }
  });

  test('密碼／Token 類賦值只使用佔位符或變數引用', () => {
    const assign = /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PASSPHRASE))\s*[=:]\s*([^\s`|,;)]+)/gi;
    const placeholder = /^(<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(.*|\*+|…|\.\.\.)?$/;
    for (const m of readme.matchAll(assign)) {
      const value = m[2].replace(/^['"]|['"]$/g, '');
      expect({ name: m[1], placeholder: placeholder.test(value) }).toEqual({ name: m[1], placeholder: true });
    }
  });

  test('不含本機測試 Database 密碼（僅於執行期由環境變數提供時檢查）', () => {
    const secret = process.env.CAMPING_TEST_DATABASE_PASSWORD;
    if (!secret) return; // 未提供時略過；密碼絕不寫入測試檔
    expect(findLeaks(readme, [{ id: 'CAMPING_TEST_DATABASE_PASSWORD', value: secret }]).length).toBe(0);
  });
});

describe('公開範圍與 Edge_Proxy runbook（Req 24.3、25.12、25.13）', () => {
  const lanSection = /^## LAN 部署\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? '';
  const runbookBytes = readFileSync(fileURLToPath(new URL('../deploy/README.md', import.meta.url)));
  const runbook = runbookBytes.toString('utf8');

  test('LAN 部署章節說明 Production 只經 Edge_Proxy、其他只限 LAN、Jenkins 只公開 webhook，並連結 runbook', () => {
    expect(lanSection).toContain('**Staging、LAN Registry 與 Deploy_Host（SSH、LM_Proxy 連接埠）只允許區域網路存取。**');
    expect(lanSection).toContain('**Production 只能經同主機的 Edge_Proxy 對網際網路公開**');
    expect(lanSection).toContain('**Jenkins 只公開 `/github-webhook/`**');
    expect(lanSection).toContain('其他公開網際網路曝露方式**不在支援範圍內**');
    expect(lanSection).toContain('[`deploy/README.md`](deploy/README.md)');
    expect(lanSection).not.toContain('唯一的例外');
  });

  test('runbook 為 UTF-8 無 BOM、LF 換行，涵蓋 Edge_Proxy、Cloudflare 與主機防火牆步驟', () => {
    expect([...runbookBytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(runbook).not.toContain('\r');
    for (const s of [
      'Forward Hostname／IP `192.168.1.121`；Forward Port `8082`', '**不要**開啟 Websockets Support', 'Force SSL', 'HSTS Enabled',
      'Forward Domain `www.our-littlemoments.com`；HTTP Code `301`；開啟 Preserve Path', '**Proxied**', '**Full (strict)**',
      '不要為 Staging 建立任何 DNS 記錄或 NPM 主機', '`/github-webhook/`',
      'LAN=192.168.1.0/24,172.17.0.0/16,172.20.0.0/16,172.21.0.0/16,172.22.0.0/16', '--public-port 80,443',
      'https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6', 'up -d --no-deps proxy',
      'verify-host.sh --lan-cidr "$LAN" --public-port 80,443', '"remote_ip"', '"client_ip"',
    ]) expect(runbook).toContain(s);
  });

  test('runbook 不含秘密，也不含主機上才有的 Edge 值（Cloudflare 範圍、Edge_Proxy 來源位址）', () => {
    expect(runbook).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(runbook).not.toMatch(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/);
    expect(runbook).not.toMatch(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/);
    for (const m of runbook.matchAll(/[0-9a-f]{32,}/gi)) {
      // 唯一允許的長十六進位字串是 Compose 已釘選的 Caddy 映像 digest。
      expect(m[0]).toBe('4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d');
    }
    // IPv4 位址只能是 LAN、本主機目前的 Docker 網段與文件保留網段（RFC 5737）。
    const allowed = new Set(['192.168.1.0/24', '192.168.1.121', '172.17.0.0/16', '172.20.0.0/16', '172.21.0.0/16', '172.22.0.0/16']);
    for (const m of runbook.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?/g)) {
      const ok = allowed.has(m[0]) || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(m[0]) || m[0] === '0.0.0.0';
      expect({ address: m[0], ok }).toEqual({ address: m[0], ok: true });
    }
    // IPv6 只能是文件保留網段 2001:db8::/32。
    for (const m of runbook.matchAll(/\b[0-9a-f]{1,4}:[0-9a-f:]*::?[0-9a-f:]*\/\d{1,3}/gi)) expect(m[0]).toBe('2001:db8::/32');
  });
});

describe('首次部署與 smoke-bot（Req 27.25、27.26、24.9、24.10）', () => {
  const runbook = read('../deploy/README.md');
  const jenkinsReadme = read('../ci/jenkins/README.md');
  /** `## <title>` 到下一個 `## ` 標題（或檔尾）之間的內容。 */
  const sectionOf = (text, title) => {
    const start = text.indexOf(`\n## ${title}\n`);
    if (start < 0) return '';
    const body = text.slice(start + title.length + 5);
    const next = body.search(/^## /m);
    return next < 0 ? body : body.slice(0, next);
  };
  /** GitHub 標題錨點：小寫、移除標點（保留字母、數字、空白、`-`、`_`）、空白改為 `-`。 */
  const slug = title => title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  /** 依序尋找每個片段，回傳各自的位置（找不到為 -1，之後的片段也不再尋找）。 */
  const positions = (text, parts) => {
    let from = 0;
    return parts.map(p => {
      if (from < 0) return -1;
      const i = text.indexOf(p, from);
      from = i < 0 ? -1 : i + p.length;
      return i;
    });
  };
  const first = sectionOf(runbook, '首次部署與 smoke-bot');
  const staging = first.slice(first.indexOf('### Staging'), first.indexOf('### Production'));
  const production = first.slice(first.indexOf('### Production'));
  const accounts = sectionOf(readme, '帳號維運指令：create-admin 與 reset-password');
  const lanSection = sectionOf(readme, 'LAN 部署');
  const LINK = 'deploy/README.md#首次部署與-smoke-bot';

  test('deploy/README.md 有「首次部署與 smoke-bot」一節，錨點與連結一致', () => {
    expect(first).not.toBe('');
    expect(slug('首次部署與 smoke-bot')).toBe(LINK.split('#')[1]);
    // README 既有的帳號維運章節錨點不變（其他章節的連結仍有效）。
    expect(slug('帳號維運指令：create-admin 與 reset-password')).toBe('帳號維運指令create-admin-與-reset-password');
    expect(readme).toContain('(#帳號維運指令create-admin-與-reset-password)');
  });

  test('前置條件：install.sh、db.env／app.env 與 lm-<env>-db 一致、映像包含 Smoke_Provisioner；app.env 經 lm-deploy app-env 寫入', () => {
    const pre = first.slice(first.indexOf('### 前置條件'), first.indexOf('### Staging'));
    for (const s of ['`install.sh`', '`db.env`', '`lm-<env>-db`', '`little_moments_staging`', '`little_moments`',
      '/app/tools/create-smoke-account.js', '`config_missing`', '--app-env-stdin', '| sudo /opt/lm/bin/lm-deploy "$E" app-env']) {
      expect(pre).toContain(s);
    }
    // 備份失敗時不寫入 app.env：文件所述的順序與 lm-deploy 的 do_deploy 相同。
    const lmDeploy = read('../deploy/bin/lm-deploy');
    const deployBody = lmDeploy.slice(lmDeploy.indexOf('do_deploy() {'), lmDeploy.indexOf('\n}\n', lmDeploy.indexOf('do_deploy() {')));
    expect(positions(deployBody, ['stage_app_env', 'do_backup', 'install_app_env', 'do_migrate']).every(i => i >= 0)).toBe(true);
    expect(positions(pre, ['驗證 stdin 的 app.env 內容', '備份', '寫入 `app.env`', 'Migration_Runner']).every(i => i >= 0)).toBe(true);
  });

  test('Staging 依序為：第一次建置失敗並取得 digest → smoke-account（no_admin）→ create-admin → smoke-account → 新的 main 建置 → staging-verified', () => {
    const cmd = 'sudo cat "$S/lm-staging-smoke" | sudo /opt/lm/bin/lm-deploy staging smoke-account <digest>';
    const order = positions(staging, [
      '`backup_create_failed`', 'reports/image-digest.txt', cmd, 'Smoke_Provisioner 未完成（no_admin）', '/app/tools/create-admin.js', cmd,
      '"account":"created"', '新的 `main` 建置', 'staging-verified',
    ]);
    expect(order.every(i => i >= 0)).toBe(true);
    // create-admin 使用 README 的 compose 指令（-T、密碼經 stdin、無終端機時必須指定兩個選項）。
    expect(staging).toContain('--profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/create-admin.js');
    expect(staging).toContain('--username <admin-name> --display-name <display-name>');
    expect(readme).toContain('--profile ops run --rm --no-deps --entrypoint bun migrate /app/tools/create-admin.js');
    // 同一個 commit 重建會在 Image Push 拒絕覆寫標籤，文件不得要求對同一 commit 按 Build Now。
    expect(read('../Jenkinsfile')).toContain('拒絕覆寫');
    expect(staging).toContain('**不要**對同一個 commit 在 `release/little-moments » main` 按 Build Now');
  });

  test('Production 在推送第一個 Release_Tag 之前，以 prod、lm-prod-smoke 與已通過 Staging 驗證的 digest 依相同順序執行', () => {
    expect(first.indexOf('### Production')).toBeGreaterThan(first.indexOf('### Staging'));
    expect(production).toContain('在推送第一個 Release_Tag **之前**');
    const cmd = 'sudo cat "$S/lm-prod-smoke" | sudo /opt/lm/bin/lm-deploy prod smoke-account <verified-digest>';
    const order = positions(production, ['E=prod DB=little_moments', '`no_admin`', cmd, 'LM_ENV=prod', '/app/tools/create-admin.js', cmd, '推送 Release_Tag']);
    expect(order.every(i => i >= 0)).toBe(true);
  });

  test('Setup_Token 只是後備；Production 的 smoke-bot 是真實 member、密碼只在 Credential_Store、以 reset-password 更換並同步更新；Smoke_Fixture 只有 smoke-bot 與管理員可見', () => {
    const ops = first.slice(first.indexOf('### Setup_Token'));
    for (const s of ['`/setup` 不再使用', '真實的 member 帳號', '`lm-prod-smoke`', '/app/tools/reset-password.js smoke-bot',
      '"$S/lm-<env>-smoke"', 'Reload existing configuration', '只有 smoke-bot 與管理員看得到', '下一次 Smoke_Test 會失敗']) {
      expect(ops).toContain(s);
    }
  });

  test('結束碼表涵蓋 lm-deploy smoke-account 與 Smoke_Provisioner 的 reason', () => {
    const lmDeploy = read('../deploy/bin/lm-deploy');
    for (const reason of ['operator_only', 'password_stdin_required', 'password_invalid', 'config_missing', 'db_start_failed',
      'proxy_start_failed', 'migrate_failed', 'smoke_account_failed', 'invalid_phase', 'deploy_in_progress',
      'no_admin', 'account_is_admin', 'account_disabled']) {
      expect(first).toContain(`\`${reason}\``);
    }
    for (const reason of ['operator_only', 'password_stdin_required', 'db_start_failed', 'proxy_start_failed', 'smoke_account_failed']) {
      expect(lmDeploy).toContain(` ${reason} `);
    }
  });

  test('README 帳號維運章節說明 create-smoke-account 並連結該節；LAN 部署以 create-admin 為主、/setup 為後備', () => {
    expect(accounts).toContain('三個指令');
    expect(accounts).toContain('bun run create-smoke-account [--username <name>] [--fixture <title>] [--password-file <path>]');
    for (const s of ['`smoke-bot`', '`Smoke Bot`', '`smoke-fixture`', '**冪等**', '**拒絕執行**', '**密碼來源只有三種**',
      '`no_admin`', '`account_is_admin`', '`account_disabled`', '結束碼為 2', '結束碼為 1',
      'lm-deploy <env> smoke-account', `(${LINK})`]) {
      expect(accounts).toContain(s);
    }
    expect(lanSection).toContain(`(${LINK})`);
    expect(lanSection.indexOf('`create-admin`')).toBeLessThan(lanSection.indexOf('`/setup` 只是後備'));
  });

  test('ci/jenkins/README.md 的 lm-staging-smoke、lm-prod-smoke 指出帳號由 lm-deploy <env> smoke-account 建立', () => {
    for (const [id, env] of [['lm-staging-smoke', 'staging'], ['lm-prod-smoke', 'prod']]) {
      const row = jenkinsReadme.split('\n').find(l => l.startsWith(`| \`release/\` | \`${id}\` |`));
      expect(row).toContain(`\`lm-deploy ${env} smoke-account\``);
      expect(row).toContain('(../../deploy/README.md#首次部署與-smoke-bot)');
    }
  });

  test('新章節不含秘密：密碼／Token 類賦值只用佔位符，digest 只以 <digest> 表示', () => {
    const assign = /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PASSPHRASE))\s*[=:]\s*([^\s`|,;)]+)/gi;
    const placeholder = /^(<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(.*|\*+|…|\.\.\.)?$/;
    for (const m of first.matchAll(assign)) {
      const value = m[2].replace(/^['"]|['"]$/g, '');
      expect({ name: m[1], placeholder: placeholder.test(value) }).toEqual({ name: m[1], placeholder: true });
    }
    expect(first).not.toMatch(/sha256:[0-9a-f]{8,}/);
    expect(first).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
