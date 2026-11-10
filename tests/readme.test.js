// README 檢查（Requirement 24.2、24.9）。
// 1. 環境變數表（<!-- env-table:start --> … <!-- env-table:end -->）列出 parseConfig 讀取的每個變數，
//    且預設值、必填與未設定時行為與 server/config.js 實作一致。
// 2. README 不含任何符合秘密模式的字串；範例值只用佔位符。
import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseConfig, DEFAULT_BIND_ADDRESS, DEFAULT_PORT, DEFAULT_ALLOWED_HOSTS, DEFAULT_DATABASE_PORT, DEFAULT_DATABASE_SSLMODE,
} from '../server/config.js';
import { createReceiptAi } from '../server/receipt-ai.js';
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

  test('App 讀取的其他變數（CAMPING_DIST、CAMPING_MIGRATIONS_DIR、CAMPING_BEDROCK_*）也列在表中', () => {
    for (const name of ['CAMPING_DIST', 'CAMPING_MIGRATIONS_DIR', 'CAMPING_BEDROCK_REGION', 'CAMPING_BEDROCK_MODEL_ID', 'CAMPING_BEDROCK_API_KEY']) {
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

  test('CAMPING_BEDROCK_* 預設為空且停用', () => {
    expect(rowOf('CAMPING_BEDROCK_API_KEY').defaultValue).toBe('');
    expect(createReceiptAi({ env: {} }).status.enabled).toBe(false);
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
