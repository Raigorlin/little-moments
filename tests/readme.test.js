// README 檢查（Requirement 24.2、24.9）。
// 1. 環境變數表（<!-- env-table:start --> … <!-- env-table:end -->）列出 parseConfig 讀取的每個變數，
//    且預設值、必填與未設定時行為與 server/config.js 實作一致。
// 2. README 不含任何符合秘密模式的字串；範例值只用佔位符。
// 3. deploy/README.md 的 Rust 版本 runbook：憑證表、Supabase 金鑰、NPM Websockets 與「首次切換」（Requirement 28；plan.md D11、D13、D16）。
// 4. Bun 版本的收據 AI 與 smoke-account 文件只以 v1.1.5 的連結保留（Requirement 28；plan.md D14）。
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
import { scanText } from '../scripts/secret-rules.mjs';

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
      'Forward Hostname／IP `192.168.1.121`；Forward Port `8082`', '**開啟** Websockets Support', 'Force SSL', 'HSTS Enabled',
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

describe('deploy/README.md：Rust 版本的憑證、金鑰與 NPM（Req 28；plan.md D12、D13、D16）', () => {
  const runbook = read('../deploy/README.md');
  const jobs = read('../ci/jenkins/jobs.groovy');
  const creds = sectionOf(runbook, '3. Jenkins 憑證');
  const keys = sectionOf(runbook, '4. Supabase 金鑰');
  const rows = creds.split('\n').filter(l => /^\| (`(ci|release|infra)\/`|SYSTEM) \|/.test(l));
  const RETIRED = ['lm-staging-db', 'lm-staging-setup-token', 'lm-prod-db', 'lm-prod-setup-token', 'lm-prod-openai-api-key'];

  test('憑證表列出 jobs.groovy 的每個資料夾憑證，release/ 恰好 15 個；退役的 5 個只出現在刪除說明', () => {
    const ids = [...jobs.matchAll(/\[id: '(lm-[a-z0-9-]+)'/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect({ id, listed: rows.some(r => r.includes(`| \`${id}\` |`)) }).toEqual({ id, listed: true });
    expect(rows.filter(r => r.startsWith('| `release/` |')).length).toBe(15);
    expect(rows.some(r => r.includes('`lm-github-webhook-secret`'))).toBe(true);
    for (const id of RETIRED) {
      expect({ id, inTable: rows.some(r => r.includes(`\`${id}\``)) }).toEqual({ id, inTable: false });
      expect(creds).toContain(`\`${id}\``);
      expect(jobs).not.toContain(`'${id}'`);
    }
    expect(creds).toContain('shred -u');
  });

  test('Supabase 金鑰：8 個鍵的用途、以 lm-supabase-keys 產生到 0600 檔案並以 install 放入 Jenkins 秘密目錄、輪替', () => {
    const appEnv = read('../deploy/compose/app.env.example');
    const names = [...appEnv.matchAll(/^(LM_[A-Z_]+)=/gm)].map(m => m[1]);
    expect(names.length).toBe(8);
    for (const name of names) expect(keys).toContain(`| \`${name}\` |`);
    for (const s of ['umask 077; deploy/bin/lm-supabase-keys env prod >', 'sudo install -o 1000 -g 1000 -m 600 "$f" "$S/lm-prod-supabase-env"',
      'shred -u "$f"', 'Reload existing configuration', '--app-env-stdin', '`app_env_invalid`', '輪替', 'session 失效', 'realtime-dev']) {
      expect(keys).toContain(s);
    }
  });

  test('NPM：www 開啟 Websockets Support；apex Redirection Host 維持 301 到 www（HTTPS）', () => {
    expect(sectionOf(runbook, '7. NPM：Production Proxy Host')).toContain('**開啟** Websockets Support');
    expect(runbook).toContain('/realtime/v1/websocket');
    const apex = sectionOf(runbook, '8. NPM：apex Redirection Host');
    for (const s of ['Scheme `https`', 'HTTP Code `301`', 'Force SSL']) expect(apex).toContain(s);
  });

  test('每個環境的設定說明 LM_ALLOWED_HOSTS、LM_SITE_URL、LM_PUBLIC_SIGNUP、LM_HEALTH_HOST 與連接埠', () => {
    const envs = sectionOf(runbook, '5. 每個環境的 `<env>.env`');
    for (const s of ['`LM_ALLOWED_HOSTS`', '`LM_SITE_URL`', '`LM_PUBLIC_SIGNUP`', '`LM_HEALTH_HOST`', '`LM_PUBLIC_PORT`', '`8081`', '`8082`',
      '`APP_SUBNET`', '`APP_MEMORY`']) {
      expect(envs).toContain(s);
    }
  });

  test('結束碼表涵蓋 lm-deploy 的每個失敗 reason', () => {
    const lmDeploy = read('../deploy/bin/lm-deploy');
    const reasons = new Set([...lmDeploy.matchAll(/die "\$EX_[A-Z]+" ([a-z_]+) /g)].map(m => m[1]));
    for (const r of ['stack_db_failed', 'stack_setup_failed', 'stack_auth_failed', 'stack_realtime_failed', 'stack_gateway_failed',
      'migration_changed', 'migrate_failed', 'drill_keys_failed', 'verify_failed']) reasons.add(r);
    const table = sectionOf(runbook, '一般部署與 `lm-deploy` 的結束碼');
    for (const r of reasons) expect({ r, listed: table.includes(`\`${r}\``) }).toEqual({ r, listed: true });
  });

  test('Bun 版本的 runbook 章節已移除：沒有 smoke-account、create-admin、Setup_Token 或收據 AI', () => {
    for (const s of ['smoke-account', 'create-admin', 'Setup_Token', 'OpenAI', '收據 AI', '## 首次部署與 smoke-bot']) {
      expect({ s, present: runbook.includes(s) }).toEqual({ s, present: false });
    }
    expect(runbook).toContain('tag `v1.1.5`');
  });

  test('列出只能在實際主機或 Jenkins 執行的檢查', () => {
    const checks = sectionOf(runbook, '只能在實際主機或 Jenkins 執行的檢查');
    for (const s of ['Rust 工具鏈映像', 'image smoke', 'Trivy', 'cosign', 'Supabase 服務', '還原演練', 'NPM Websockets', 'CasC', 'D10', 'v2.0.0']) {
      expect(checks).toContain(s);
    }
  });
});

describe('首次切換：v1.1.5 → v2.0.0（Req 28；plan.md D10、D11）', () => {
  const runbook = read('../deploy/README.md');
  const jenkinsReadme = read('../ci/jenkins/README.md');
  const cutover = sectionOf(runbook, '首次切換');
  const back = sectionOf(runbook, '回滾到 v1.1.5');
  const code = text => [...text.matchAll(/^ *```sh\n([\s\S]*?)^ *```$/gm)].map(m => m[1]).join('\n');

  test('章節與錨點存在，Jenkinsfile 的 bootstrap 訊息、ci/jenkins/README.md 與 README 都指向它', () => {
    expect(cutover).not.toBe('');
    expect(slug('首次切換')).toBe('首次切換');
    expect(slug('回滾到 v1.1.5')).toBe('回滾到-v115');
    expect(back).not.toBe('');
    expect(read('../Jenkinsfile')).toContain('deploy/README.md 的首次切換');
    expect(cutover).toContain('Production 尚未完成首次部署，請依 deploy/README.md 的首次切換步驟完成 bootstrap');
    expect(jenkinsReadme).toContain('(../../deploy/README.md#首次切換)');
    expect(readme).toContain('(deploy/README.md#首次切換)');
  });

  test('步驟順序與 D11 相同：Bun 備份 → NPM 只限 LAN 與 Websockets → 停止 Bun 並封存 → install.sh → 金鑰與 CasC → 合併 main → bootstrap → 開放 → 空 commit 發布 v2.0.0', () => {
    const order = positions(cutover, [
      'sudo /opt/lm/bin/lm-deploy prod backup', '/var/backups/little-moments/bun-v1.1.5', 'sha256sum -c', 'lm-prod_pgdata',
      '**Websockets Support**',
      'sudo docker compose -p "lm-$E" down\n', 'state.bun-v1.1.5',
      'sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443',
      '`lm-prod-supabase-env`', 'Reload existing configuration',
      '**合併到 `main`**', '`--provision`', 'reports/image-digest.txt',
      'LM_PUBLIC_SIGNUP=true', 'sudo cat "$S/lm-prod-supabase-env" | sudo /opt/lm/bin/lm-deploy prod deploy <digest> --app-env-stdin',
      'http://192.168.1.121:8082/register', '\\"username\\":\\"smoke-bot\\"', 'LM_PUBLIC_SIGNUP=false', 'up -d --no-deps app-<color>',
      'sudo /opt/lm/bin/lm-deploy prod finalize', 'Publicly Accessible', '--allow-empty', '`v2.0.0`',
    ]);
    expect(order.map((i, n) => ({ n, found: i >= 0 }))).toEqual(order.map((_, n) => ({ n, found: true })));
  });

  test('全新開始：Bun 的資料備份但不匯入，任何指令都不刪除資料卷', () => {
    expect(cutover).toContain('不匯入');
    for (const line of code(cutover + back).split('\n')) {
      expect({ line, destructive: /down\s+-v|volume\s+rm|rm\s+-rf/.test(line) }).toEqual({ line, destructive: false });
    }
  });

  test('smoke-bot 的密碼只經 root shell 的 printf 與管線傳遞；章節不含秘密', () => {
    const assign = /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PASSPHRASE))\s*[=:]\s*([^\s`|,;)]+)/gi;
    const placeholder = /^(<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(.*|\*+|…|\.\.\.)?$/;
    for (const m of cutover.matchAll(assign)) {
      const value = m[2].replace(/^['"]|['"]$/g, '');
      expect({ name: m[1], placeholder: placeholder.test(value) }).toEqual({ name: m[1], placeholder: true });
    }
    expect(cutover).not.toMatch(/sha256:[0-9a-f]{8,}/);
    for (const line of code(cutover).split('\n')) {
      expect({ line, echo: /\becho\s+[^;|&\n]*\$/.test(line) }).toEqual({ line, echo: false });
    }
  });

  test('回滾到 v1.1.5：停用 release/little-moments、保留 sbdata、以 tag v1.1.5 重新安裝並以 pgdata 的資料啟動 Bun', () => {
    const order = positions(back, ['Disable Multibranch Pipeline', 'down', '.rust-v2', '.bun-v1.1.5', 'checkout --detach v1.1.5',
      'install.sh', 'APP_IMAGE_NEW', 'lm-prod_pgdata', 'Websockets Support']);
    expect(order.every(i => i >= 0)).toBe(true);
  });
});

describe('Bun 版本文件的歷史連結（Req 28；plan.md D14）', () => {
  const jenkinsReadme = read('../ci/jenkins/README.md');
  const V = 'https://github.com/Raigorlin/little-moments/blob/v1.1.5/deploy/README.md';
  const accounts = sectionOf(readme, '帳號維運指令：create-admin 與 reset-password');
  const lanSection = sectionOf(readme, 'LAN 部署');

  test('README 新增 CI/CD 章節：分支流程、版本來源、Pipeline 與 deploy/README.md 的位置', () => {
    const cicd = sectionOf(readme, 'CI/CD 與部署（Rust 版本）');
    for (const s of ['`rust`', '`ci/little-moments`', '`release/little-moments`', '`main`', '[workspace.package] version', '`Jenkinsfile`',
      '[`ci/jenkins/README.md`](ci/jenkins/README.md)', '[`deploy/README.md`](deploy/README.md)', 'Websockets Support',
      'https://www.our-littlemoments.com', 'https://our-littlemoments.com']) {
      expect(cicd).toContain(s);
    }
    expect(slug('CI/CD 與部署（Rust 版本）')).toBe('cicd-與部署rust-版本');
    expect(readme).toContain('(#cicd-與部署rust-版本)');
    // 既有的 Rust 本機執行章節保留。
    expect(readme).toContain('trunk build --release --config crates/web/Trunk.toml');
  });

  test('README 的 Bun 部署章節標示為 v1.x，smoke-account 與收據 AI 的連結指向 tag v1.1.5', () => {
    expect(lanSection).toContain('Bun 版本（v1.x');
    expect(lanSection).toContain(`(${V}#首次部署與-smoke-bot)`);
    expect(lanSection.indexOf('`create-admin`')).toBeLessThan(lanSection.indexOf('`/setup` 只是後備'));
    expect(accounts).toContain('三個指令');
    expect(accounts).toContain('Rust 版本沒有 `create-admin`');
    expect(accounts).toContain(`(${V}#首次部署與-smoke-bot)`);
    const ai = sectionOf(readme, '收據 AI（OpenAI）');
    expect(ai).toContain('Rust 版本沒有收據 AI');
    expect(ai).toContain(`(${V}#production-收據-aiopenai)`);
    expect(readme).not.toContain('(deploy/README.md#首次部署與-smoke-bot)');
    expect(readme).not.toContain('(deploy/README.md#production-收據-aiopenai)');
  });

  test('ci/jenkins/README.md：憑證表不再有 OpenAI 憑證；smoke 與 Supabase 金鑰的說明指向 deploy/README.md', () => {
    const rows = jenkinsReadme.split('\n').filter(l => /^\| `(ci|release|infra)\/` \|/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.toLowerCase()).not.toContain('openai');
    for (const id of ['lm-staging-smoke', 'lm-prod-smoke']) {
      const row = rows.find(l => l.startsWith(`| \`release/\` | \`${id}\` |`));
      expect(row).toContain('`smoke-bot`');
      expect(row).toContain('(../../deploy/README.md#首次切換)');
    }
    expect(jenkinsReadme).toContain('(../../deploy/README.md#4-supabase-金鑰)');
    expect(jenkinsReadme).toContain('`release/` 顯示上表 15 個');
    expect(jenkinsReadme).not.toContain('- 收據 AI（`CAMPING_OPENAI_*`');
    expect(jenkinsReadme).not.toContain('production-收據-aiopenai');
  });

  test('README.md 的收據 AI 說明（Bun 版本）仍與 v1.x 的行為一致', () => {
    const ai = sectionOf(readme, '收據 AI（OpenAI）');
    const host = ai.split('\n').find(l => l.startsWith('- **Deploy_Host。**'));
    for (const s of ['只有 Production 啟用', 'Staging 停用', '`ci/` 不定義', '`/admin`', '`off`']) expect(host).toContain(s);
    const fileRow = rowOf('CAMPING_OPENAI_API_KEY_FILE');
    for (const s of ['`lm-deploy`', 'Staging 為空字串', '`/run/secrets/openai-api-key`']) expect(fileRow.behavior).toContain(s);
  });

  test('三份文件不含符合 OpenAI 金鑰格式的字串（Req 24.9）', () => {
    const runbook = read('../deploy/README.md');
    for (const [path, text] of [['README.md', readme], ['deploy/README.md', runbook], ['ci/jenkins/README.md', jenkinsReadme]]) {
      expect({ path, findings: scanText(text, { path }).filter(f => f.rule === 'openai-key') }).toEqual({ path, findings: [] });
      expect({ path, match: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(text) }).toEqual({ path, match: false });
    }
  });
});

describe('README 行程表文件（trip-planning-workflow-enhance Req 24.1 至 24.6）', () => {
  const features = sectionOf(readme, 'Features');
  const featureItem = prefix => features.split('\n').find(l => l.startsWith(`- **${prefix}:**`)) ?? '';
  const itinerary = featureItem('Itinerary');
  const invitations = featureItem('Invitations and permissions');
  const plan = sectionOf(readme, 'Plan a trip');
  const planLines = plan.split('\n');

  // 九個頂層步驟：{ n, title, body }，body 含該步驟的子項目行。
  const steps = (() => {
    const out = [];
    for (const line of planLines) {
      const m = /^(\d+)\. \*\*(.+?)\*\*/.exec(line);
      if (m) out.push({ n: Number(m[1]), title: m[2], lines: [line] });
      else if (out.length && /^ {3}\S/.test(line)) out.at(-1).lines.push(line);
    }
    return out.map(s => ({ ...s, body: s.lines.join('\n') }));
  })();
  const step = n => steps.find(s => s.n === n);
  const substeps = n => step(n).lines.slice(1).map(l => l.replace(/^ {3}\d+\. /, ''));
  const has = (text, parts) => parts.map(p => ({ p, ok: text.includes(p) }));
  const allOk = results => expect(results.filter(r => !r.ok)).toEqual([]);

  describe('**Itinerary:** 項目（24.1、24.2、24.5）', () => {
    test('項目存在且以 **Itinerary:** 開頭', () => {
      expect(itinerary.startsWith('- **Itinerary:**')).toBe(true);
    });

    test('(a) 預設顯示「行程圖」，包含受邀旅伴的編輯者可以切換到「規劃行程」', () => {
      allOk(has(itinerary, ['**行程表**', '**行程圖**', '**規劃行程**', 'by default', 'invited companions']));
    });

    test('(b) 行程圖以動態插畫一次呈現整趟旅行，每天一段，並涵蓋出發、停留、抵達、活動與餐點', () => {
      allOk(has(itinerary, ['animated illustration', 'one section per day', 'leaves from', 'at what time',
        'stops on the way', 'expected to arrive', 'activities and meals']));
    });

    test('(c) 規劃行程以勾選與選單一次規劃一天', () => {
      allOk(has(itinerary, ['checkboxes and menus', 'one day at a time']));
    });

    test('(d) 「地點與車」集中管理地點清單與車輛', () => {
      allOk(has(itinerary, ['**地點與車**', 'place list', 'vehicles']));
    });

    test('(e) 每台車每天最多一條路線、每條最多 6 個停靠點，並列出四種任務類型', () => {
      allOk(has(itinerary, ['at most one route per day', 'at most 6 stops', 'shopping', 'pick-up or drop-off', 'gear pick-up or return', 'other']));
    });

    test('(f) 「常用活動」為第一天、中間的日子與最後一天提供不同建議，也可以新增自訂活動', () => {
      allOk(has(itinerary, ['**常用活動**', 'first day', 'middle days', 'last day', 'custom activities']));
    });

    test('(g) 「料理菜單」的餐點自動出現在當天行程，並顯示料理名稱與食材', () => {
      allOk(has(itinerary, ['**料理菜單**', 'automatically', 'dish names and ingredients']));
    });

    test('(h) 「文字版」顯示自動產生、格式一致的行程文字，「複製文字」一鍵複製', () => {
      allOk(has(itinerary, ['**文字版**', '**複製文字**', 'generated from the plan', 'consistent format', 'one click']));
    });

    test('24.2：路線只是示意，逐一寫明四項不提供的功能，並說明抵達時間由規劃的人填寫、App 不計算', () => {
      allOk(has(itinerary, ['only a sketch', 'no navigation', 'no live location', 'no driving-time estimates', 'no return-time prediction',
        "arrival time is entered by the person planning", 'never calculates it']));
    });

    test('24.5：七個介面名稱以粗體繁體中文原樣寫出，第一次出現時後方括號附英文說明', () => {
      const names = ['行程圖', '規劃行程', '地點與車', '常用活動', '未分配採買清單', '文字版', '複製文字'];
      const results = names.map(name => {
        const i = readme.indexOf(name);
        const boldFirst = readme.slice(i - 2, i + name.length + 2) === `**${name}**`;
        const annotated = /^\*\* \([a-z][^()]*\)/.test(readme.slice(i + name.length, i + name.length + 60));
        return { name, boldFirst, annotated };
      });
      expect(results.filter(r => !r.boldFirst || !r.annotated)).toEqual([]);
    });

    test('24.5：七個介面名稱第一次出現時的英文說明依序為 poster、planner、places and cars、common activities、unassigned shopping list、text version、copy text', () => {
      const expected = {
        行程圖: 'itinerary poster', 規劃行程: 'itinerary planner', 地點與車: 'places and cars', 常用活動: 'common activities',
        未分配採買清單: 'unassigned shopping list', 文字版: 'text version', 複製文字: 'copy text',
      };
      for (const [name, english] of Object.entries(expected)) {
        const i = readme.indexOf(`**${name}** (`);
        expect({ name, text: readme.slice(i, i + name.length + 6 + english.length + 1) }).toEqual({ name, text: `**${name}** (${english})` });
      }
    });
  });

  describe('**Invitations and permissions:** 項目（24.6）', () => {
    test('項目存在且以 **Invitations and permissions:** 開頭', () => {
      expect(invitations.startsWith('- **Invitations and permissions:**')).toBe(true);
    });

    test('受邀旅伴（collaborators）可以在「行程表」刪除路線、途中任務、活動與地點', () => {
      allOk(has(invitations, ['collaborators', '**行程表**', 'routes', 'stop tasks', 'activities', 'places']));
      expect(invitations).toMatch(/collaborators\) can delete routes, stop tasks, activities, and places in \*\*行程表\*\*/);
    });

    test('旅伴、料理、採買品項、裝備與車輛仍只有旅行建立者與管理員可以刪除', () => {
      expect(invitations).toMatch(/companions, meals, shopping items, gear, and vehicles can still be deleted only by the trip creator and administrators/);
    });

    test('不再寫成只有旅行建立者與管理員可以刪除旅行內容', () => {
      expect(invitations).not.toMatch(/only (?:the )?trip creators? and administrators (?:can )?delete/i);
      expect(invitations).not.toMatch(/delete trip content/i);
      expect(invitations).not.toMatch(/Only trip creators and administrators can delete/i);
    });
  });

  describe('## Plan a trip（24.3、24.4）', () => {
    test('維持 9 個步驟，主題與順序不變', () => {
      expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(steps.map(s => s.title)).toEqual([
        'Create or open a handbook.', 'Add companions and vehicles.', 'Plan the itinerary.', 'Plan meals.', 'Organize shopping.',
        'Divide the gear.', 'Record expenses (account mode).', 'Get ready to leave.', 'Keep or share the handbook.',
      ]);
    });

    test('第 2 步：旅伴在「旅行選單」新增；車輛資料在「旅行選單」或「地點與車」編輯且是同一份；地點清單在「地點與車」；出發時間與地點在第 3 步的 Route 設定', () => {
      allOk(has(step(2).body, ['**旅行選單**', 'companions', 'driver, passengers, and seat count', 'trip menu or in **地點與車**',
        'both places edit the same data', 'place list in **地點與車**', 'does not have a departure time or place', 'per day on each route in step 3']));
    });

    test('第 3 步有 7 個子項 (a) 至 (g)，以「行程表」開頭', () => {
      expect(step(3).lines[0]).toContain('In **行程表**:');
      expect(substeps(3).length).toBe(7);
    });

    test('第 3 步 (a) 在其他各點之前：切換到「規劃行程」並選擇一天', () => {
      const [a] = substeps(3);
      allOk(has(a, ['Switch to **規劃行程**', 'select a day']));
    });

    test('第 3 步 (b)：新增路線、從地點清單選擇出發地、每個停靠點與終點，可就地新增地點，出發時間可先留空', () => {
      allOk(has(substeps(3)[1], ['Add a route for each vehicle', 'starting place', "each stop's place", 'destination', 'place list',
        'added on the spot', 'departure time can be left empty']));
    });

    test('第 3 步 (c)：採買停靠點自動列出駕駛與乘客負責買的品項、多個時列在第一個、換車的方式、未分配採買清單', () => {
      allOk(has(substeps(3)[2], ['shopping stop', 'driver and passengers', '**誰負責買**', '**採買清單**', 'first one',
        'change **誰負責買**', "vehicle's driver and passengers", '**未分配採買清單**']));
    });

    test('第 3 步 (d) 至 (f)：抵達時間、常用活動與自訂活動、料理菜單餐點的時間與名稱修改位置', () => {
      const [, , , d, e, f] = substeps(3);
      allOk(has(d, ['expected arrival time']));
      allOk(has(e, ['**常用活動**', 'custom activity']));
      allOk(has(f, ['**料理菜單**', 'default by mealtime', '**規劃行程**', "meal's name and ingredients in **料理菜單**"]));
    });

    test('第 3 步 (g) 在其他各點之後：回到「行程圖」，展開「文字版」，用「複製文字」貼到聊天群組', () => {
      const g = substeps(3).at(-1);
      allOk(has(g, ['Go back to **行程圖**', '**文字版**', '**複製文字**', 'group chat']));
      // 其餘各子項都不是回到行程圖的步驟，且順序為 規劃行程 → … → 行程圖。
      const body = substeps(3);
      expect(body.slice(0, -1).filter(s => s.includes('Go back to **行程圖**'))).toEqual([]);
      expect(body[0]).toContain('**規劃行程**');
    });

    test('第 8 步以 activity 稱呼出發模式顯示的下一個未完成項目，不描述 Route 或 Stop', () => {
      const body = step(8).body;
      expect(body).toContain('next unfinished activity');
      expect(body).not.toMatch(/\broutes?\b/i);
      expect(body).not.toMatch(/\bstops?\b/i);
    });

    test('24.4：README 不含列出的舊英文片語', () => {
      const banned = [
        'Plan dated and timed stops', 'mark stops complete', 'filter by vehicle',
        'Each vehicle can have its own departure time and meeting place', 'The add-stop button sits beside the date tabs',
        "set each vehicle's departure time and place", 'add a stop with a time, location, type, notes, and participants',
        "Vehicle filters show each car's stops separately", 'the next unfinished stop',
      ];
      const lower = readme.toLowerCase();
      expect(banned.filter(p => lower.includes(p.toLowerCase()))).toEqual([]);
    });

    test('24.4：不以其他文字描述在 Vehicle_Dialog 設定出發時間與出發地點', () => {
      expect(readme).not.toMatch(/Vehicle_Dialog/);
      expect(readme).not.toMatch(/vehicle (?:dialog|form)[^.\n]*(?:departure|meeting)/i);
      expect(step(2).body).not.toMatch(/vehicle'?s? (?:departure|meeting)[^.\n]*(?:set|enter|edit)/i);
    });
  });

  describe('語言與格式（24.5）', () => {
    test('Itinerary 與 Invitations 項目、Plan a trip 第 2、3 步除介面名稱與括號內英文說明外沒有其他中日韓文字', () => {
      const cjk = /[\u3400-\u9fff]/;
      const stripNames = text => text.replace(/\*\*[^*]*\*\*/g, '');
      const texts = { itinerary, invitations, step2: step(2).body, step3: step(3).body };
      for (const [id, text] of Object.entries(texts)) {
        expect({ id, cjk: cjk.test(stripNames(text)) }).toEqual({ id, cjk: false });
      }
    });
  });
});
