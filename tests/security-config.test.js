// Feature: security-hardening, configuration and document checks (task 10.4).
// Static checks of docs/deploy-nginx.md, Dockerfile, docker-compose.yml, ignore files,
// package.json, and scripts/serve.mjs. Secret matches are printed only as Redacted_Values.
import { test, expect, describe } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { scanText } from '../scripts/secret-rules.mjs';

const ROOT = resolve(import.meta.dir, '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');
const lines = text => text.split(/\r?\n/);

// ---------- docs/deploy-nginx.md ----------

const nginxConfig = () => {
  const doc = read('docs/deploy-nginx.md');
  const start = doc.indexOf('## Example nginx config');
  expect(start).toBeGreaterThan(-1);
  const block = doc.slice(start).match(/```nginx\r?\n([\s\S]*?)```/);
  expect(block).not.toBeNull();
  // Drop comments so that wording in comments does not affect the checks.
  return lines(block[1]).map(l => l.replace(/#.*$/, '')).join('\n');
};

// Split the config into top-level `server { ... }` blocks by brace depth.
const serverBlocks = config => {
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(config))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < config.length; i++) {
      if (config[i] === '{') depth++;
      else if (config[i] === '}' && --depth === 0) break;
    }
    blocks.push(config.slice(m.index, i + 1));
    re.lastIndex = i + 1;
  }
  return blocks;
};

const sizeInBytes = value => {
  const m = /^(\d+)([kKmMgG]?)$/.exec(value);
  if (!m) return NaN;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
};

describe('Example_Nginx_Config (docs/deploy-nginx.md)', () => {
  const config = nginxConfig();
  const blocks = serverBlocks(config);
  const www = blocks.find(b => /server_name\s+www\.our-littlemoments\.com\s*;/.test(b));

  test('has the www application server block', () => {
    expect(www).toBeDefined();
  });

  test('HSTS max-age=15552000 on the www block and on every HSTS header (Req 11.6)', () => {
    const hsts = [...config.matchAll(/add_header\s+Strict-Transport-Security\s+"([^"]*)"/gi)].map(m => m[1]);
    expect(hsts.length).toBeGreaterThan(0);
    for (const value of hsts) expect(value).toMatch(/^max-age=15552000\b/);
    expect(www).toMatch(/add_header\s+Strict-Transport-Security\s+"max-age=15552000"\s+always\s*;/);
  });

  test('client_max_body_size is set to 4 MiB or less (Req 17.11)', () => {
    const sizes = [...config.matchAll(/client_max_body_size\s+(\S+?)\s*;/g)].map(m => m[1]);
    expect(www).toMatch(/client_max_body_size\s+\S+\s*;/);
    for (const size of sizes) {
      const bytes = sizeInBytes(size);
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  test('no add_header sets an Access-Control-* header (Req 12.6)', () => {
    expect(config).not.toMatch(/add_header\s+["']?Access-Control-/i);
    expect(config).not.toMatch(/Access-Control-/i);
  });

  test('nginx does not answer OPTIONS requests itself (Req 12.6)', () => {
    expect(config).not.toMatch(/OPTIONS/i);
    expect(config).not.toMatch(/\$request_method/);
    expect(config).not.toMatch(/\blimit_except\b/);
  });

  test('every request goes to the App_Server and no file is served from disk (Req 20.8)', () => {
    expect(config).not.toMatch(/^\s*(root|alias|try_files|autoindex)\b/m);
    expect(www).toMatch(/location\s+\/\s*\{[^}]*proxy_pass\s+http:\/\/127\.0\.0\.1:\d+\s*;/);
  });

  test('dot-prefixed segments return 404 except /.well-known/, before location / (Req 20.8)', () => {
    const dotRule = /location\s+~\s+\/\\\.\(\?!well-known\/\)\s*\{\s*return\s+404\s*;\s*\}/;
    const dot = www.search(dotRule);
    const root = www.search(/location\s+\/\s*\{/);
    expect(dot).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(-1);
    expect(dot).toBeLessThan(root);
    // The regex in the rule behaves as required.
    const re = /\/\.(?!well-known\/)/;
    for (const p of ['/.env', '/.git/config', '/a/.secrets/openai_api_key', '/.kiro/', '/.well-known']) expect(re.test(p)).toBe(true);
    for (const p of ['/.well-known/acme-challenge/x', '/login', '/assets/app.js', '/a.b/c']) expect(re.test(p)).toBe(false);
  });
});

// ---------- Dockerfile ----------

// Parse the Dockerfile into instructions (continuation lines joined) grouped by stage.
const dockerStages = () => {
  const joined = read('Dockerfile').replace(/\\\r?\n/g, ' ');
  const stages = [];
  lines(joined).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\w+)\s+(.*)$/.exec(line);
    if (!m) return;
    const instr = { op: m[1].toUpperCase(), args: m[2].trim(), line: i + 1 };
    if (instr.op === 'FROM') {
      const name = /\bAS\s+(\S+)/i.exec(instr.args)?.[1]?.toLowerCase() ?? '';
      stages.push({ name, from: instr.args, instrs: [] });
    } else if (stages.length) {
      stages.at(-1).instrs.push(instr);
    }
  });
  return stages;
};

// KEY=VALUE pairs from ENV, ARG, and LABEL arguments.
const assignments = args => {
  const out = [];
  const re = /([A-Za-z_][A-Za-z0-9_.-]*)(?:=("[^"]*"|'[^']*'|\S*))?/g;
  let m;
  while ((m = re.exec(args))) out.push({ name: m[1], value: (m[2] ?? '').replace(/^["']|["']$/g, '') });
  return out;
};

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD)/i;
// A *_FILE variable names the secret's location, not the secret itself, so a
// container path such as /run/secrets/... is allowed (Requirement 14.6).
const isSecretValue = ({ name, value }) => value !== '' && SECRET_NAME.test(name) && !(/_FILE$/i.test(name) && /^\/run\/secrets\//.test(value));

describe('Dockerfile', () => {
  const stages = dockerStages();
  const runtime = stages.at(-1);

  test('the runtime stage copies only the allowed paths and never the whole context (Req 20.6)', () => {
    expect(runtime.name).toBe('runtime');
    const copies = runtime.instrs.filter(i => i.op === 'COPY' || i.op === 'ADD');
    expect(copies.length).toBeGreaterThan(0);
    expect(runtime.instrs.some(i => i.op === 'ADD')).toBe(false);
    const allowed = new Set(['/app/dist', '/app/server', '/app/src', '/app/scripts/serve.mjs', '/app/node_modules']);
    for (const copy of copies) {
      const parts = copy.args.split(/\s+/).filter(p => !p.startsWith('--'));
      const sources = parts.slice(0, -1);
      expect(copy.args).toMatch(/--from=build\b/);
      for (const src of sources) {
        expect(['.', './', '/app', '/app/'].includes(src)).toBe(false);
        expect(allowed.has(src)).toBe(true);
      }
    }
  });

  test('CMD starts Bun without inspector, hot reload, or watch flags (Req 19.5)', () => {
    const cmds = stages.flatMap(s => s.instrs).filter(i => i.op === 'CMD' || i.op === 'ENTRYPOINT');
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) expect(cmd.args).not.toMatch(/--(inspect(-brk|-wait)?|hot|watch)\b/);
    expect(runtime.instrs.find(i => i.op === 'CMD').args).toMatch(/"bun"\s*,\s*"scripts\/serve\.mjs"/);
  });

  test('ENV, ARG, and LABEL set no secret value (Req 14.5)', () => {
    const bad = [];
    for (const instr of stages.flatMap(s => s.instrs)) {
      if (!['ENV', 'ARG', 'LABEL'].includes(instr.op)) continue;
      for (const pair of assignments(instr.args)) {
        if (isSecretValue(pair)) bad.push(`Dockerfile:${instr.line} ${instr.op} ${pair.name}`);
        if (pair.name === 'CAMPING_OPENAI_API_KEY') bad.push(`Dockerfile:${instr.line} sets CAMPING_OPENAI_API_KEY`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ---------- docker-compose.yml ----------

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  test('provides the OpenAI key only as a mounted secret file (Req 14.6)', () => {
    expect(compose).not.toMatch(/CAMPING_OPENAI_API_KEY(?!_FILE)/);
    // Top-level secret backed by the local key file, attached to the app service.
    expect(compose).toMatch(/^secrets:\s*\r?\n\s+openai_api_key:\s*\r?\n\s+file:\s*\.\/\.secrets\/openai_api_key\s*$/m);
    expect(compose).toMatch(/^\s{4}secrets:\s*\r?\n\s+-\s*openai_api_key\s*$/m);
    // Compose mounts the secret at /run/secrets/openai_api_key; the effective
    // CAMPING_OPENAI_API_KEY_FILE (compose override or image ENV) must name it.
    const override = /CAMPING_OPENAI_API_KEY_FILE\s*[:=]\s*["']?([^\s"']+)/.exec(compose)?.[1];
    const imageEnv = dockerStages().at(-1).instrs
      .filter(i => i.op === 'ENV')
      .flatMap(i => assignments(i.args))
      .find(p => p.name === 'CAMPING_OPENAI_API_KEY_FILE')?.value;
    expect(override ?? imageEnv).toBe('/run/secrets/openai_api_key');
  });

  test('environment, build args, and labels set no secret value (Req 14.5)', () => {
    const bad = [];
    lines(compose).forEach((line, i) => {
      const m = /^\s*-?\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^"'#]*?)["']?\s*$/.exec(line);
      if (!m) return;
      const pair = { name: m[1], value: m[2].trim() };
      if (pair.value && SECRET_NAME.test(pair.name) && !/_FILE$/i.test(pair.name) && !/^(file|openai_api_key)$/.test(pair.name)) {
        bad.push(`docker-compose.yml:${i + 1} ${pair.name}`);
      }
    });
    expect(bad).toEqual([]);
  });
});

// ---------- .env.example ----------

describe('.env.example', () => {
  const path = join(ROOT, '.env.example');
  // .env.example is optional; when absent, Requirement 14.7 has nothing to check.
  // The test still runs (instead of being skipped) so the Unit_Suite reports no skips.
  test('gives every variable an empty value or an angle-bracket placeholder when present (Req 14.7)', () => {
    if (!existsSync(path)) return;
    const bad = [];
    lines(readFileSync(path, 'utf8')).forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (value !== '' && !/^<[^<>]+>$/.test(value)) bad.push(`.env.example:${i + 1} ${m[1]}`);
    });
    expect(bad).toEqual([]);
  });
});

// ---------- Secret_Scanner rules over configuration files ----------

test('Dockerfile, docker-compose.yml, and .env.example match no Secret_Scanner rule (Req 14.9, 14.10)', () => {
  const findings = [];
  for (const file of ['Dockerfile', 'docker-compose.yml', '.env.example']) {
    if (!existsSync(join(ROOT, file))) continue;
    findings.push(...scanText(read(file), { path: file }));
  }
  // Only path, line, rule, and Redacted_Value are printed; the raw value is non-enumerable.
  const report = findings.map(f => `${f.path}:${f.line} ${f.rule} ${f.redacted}`);
  expect(report).toEqual([]);
});

// ---------- Ignore files ----------

// Minimal gitignore-style matching: last matching rule wins, `!` negates, a trailing
// `/` marks a directory, and a pattern without `/` matches any path segment.
const ignoreRules = text => lines(text).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(raw => {
  const negate = raw.startsWith('!');
  let pattern = negate ? raw.slice(1) : raw;
  const dirOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/$/, '').replace(/^\//, '');
  const body = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return { negate, dirOnly, re: new RegExp(`^${body}$`) };
});

const isIgnored = (rules, name, { dir = false } = {}) => {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !dir) continue;
    if (rule.re.test(name)) ignored = !rule.negate;
  }
  return ignored;
};

// A required entry is satisfied when a sample name for it is ignored.
const sampleFor = entry => ({ name: entry.replace(/\/$/, '').replace(/\*/g, 'sample'), dir: entry.endsWith('/') || !entry.includes('.') || ['.git', '.kiro', '.secrets'].includes(entry.replace(/\/$/, '')) });

const missingEntries = (file, required) => {
  const rules = ignoreRules(read(file));
  return required.filter(entry => {
    const { name, dir } = sampleFor(entry);
    return !isIgnored(rules, name, { dir });
  });
};

test('.dockerignore excludes every required entry (Req 20.5)', () => {
  const required = ['.git', '.kiro', '.env', '.env.*', '.secrets/', 'data', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*.db', '*.pem', '*.key', '*.p12', '*.pfx'];
  expect(missingEntries('.dockerignore', required)).toEqual([]);
});

test('.gitignore excludes every required entry (Req 20.7)', () => {
  const required = ['.env', '.env.*', '.secrets/', 'data/', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*.db'];
  expect(missingEntries('.gitignore', required)).toEqual([]);
});

test('ignore matching helper treats negation and wildcards correctly', () => {
  const rules = ignoreRules('.env\n.env.*\n!.env.example\n*.sqlite-*\n');
  expect(isIgnored(rules, '.env.local')).toBe(true);
  expect(isIgnored(rules, '.env.example')).toBe(false);
  expect(isIgnored(rules, 'accounts.sqlite-wal')).toBe(true);
  expect(isIgnored(rules, 'accounts.sqlite')).toBe(false);
});

// ---------- package.json and scripts/serve.mjs ----------

test('the start script runs Bun without inspector, hot reload, or watch flags (Req 19.5)', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(typeof pkg.scripts?.start).toBe('string');
  expect(pkg.scripts.start).not.toMatch(/--(inspect(-brk|-wait)?|hot|watch)\b/);
  expect(pkg.scripts.start).toMatch(/^bun\s+scripts\/serve\.mjs$/);
});

test('Bun.serve maxRequestBodySize is at most 4,194,304 bytes (Req 17.7)', () => {
  const source = read('scripts/serve.mjs');
  const values = [...source.matchAll(/maxRequestBodySize\s*:\s*([0-9_]+)/g)].map(m => Number(m[1].replace(/_/g, '')));
  expect(values.length).toBe(1);
  expect(values[0]).toBeGreaterThan(0);
  expect(values[0]).toBeLessThanOrEqual(4_194_304);
  // No Bun.serve call without the limit.
  expect((source.match(/Bun\.serve\s*\(/g) ?? []).length).toBe(1);
});

// ---------- No obsolete Bedrock variable references (Req 22.6) ----------

// Built from fragments so that this file does not match its own search.
const OBSOLETE = ['CAMPING', 'BEDROCK'].join('_');
const SKIP_DIRS = new Set(['.kiro', 'node_modules', '.git', 'dist', '.tmp-e2e-dist', 'test-results', 'playwright-report', 'coverage', 'data', 'previews']);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const looksBinary = path => {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
};

const walk = (dir, out) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || /^dist-/.test(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
};

test('no obsolete Bedrock variable is referenced outside .kiro/, node_modules/, and the Build_Output (Req 22.6)', () => {
  const hits = [];
  const needle = OBSOLETE.toLowerCase();
  for (const file of walk(ROOT, [])) {
    if (statSync(file).size > MAX_TEXT_BYTES || looksBinary(file)) continue;
    lines(readFileSync(file, 'utf8')).forEach((line, i) => {
      if (line.toLowerCase().includes(needle)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});
