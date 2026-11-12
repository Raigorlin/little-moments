// Feature: security-hardening, configuration and document checks (task 10.4).
// Static checks of the reverse proxy config (deploy/caddy), Dockerfile, deploy/compose, ignore files,
// package.json, and scripts/serve.mjs. Secret matches are printed only as Redacted_Values.
//
// Merge note (jenkins-cicd-deploy task 18.3): security-harden checked its nginx example (docs/deploy-nginx.md)
// and docker-compose.yml. This merge keeps main's deployment (Caddy + deploy/compose), so the same rules are
// checked against those files. Task 18.5 replaced the Bedrock variables with CAMPING_OPENAI_*; the OpenAI
// key-file check (Req 14.6) applies to deploy/compose, where the key comes only from a key file.
import { test, expect, describe } from 'bun:test';
import { YAML } from 'bun';
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { scanText } from '../scripts/secret-rules.mjs';

const ROOT = resolve(import.meta.dir, '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');
const lines = text => text.split(/\r?\n/);
const filesIn = (dir, pattern) => readdirSync(join(ROOT, dir)).filter(name => pattern.test(name)).map(name => `${dir}/${name}`);

// ---------- Reverse proxy (deploy/caddy) ----------

const CADDY_FILES = filesIn('deploy/caddy', /\.(caddy|tmpl)$|^Caddyfile$/);
// Drop comments so that wording in comments does not affect the checks.
const caddyText = path => lines(read(path)).map(l => l.replace(/(^|\s)#.*$/, '')).join('\n');
const caddyConfig = () => CADDY_FILES.map(caddyText).join('\n');

// Caddy sizes use SI units for KB/MB/GB and binary units for KiB/MiB/GiB.
const caddyBytes = value => {
  const m = /^(\d+)\s*(B|KB|K|MB|M|GB|G|KiB|MiB|GiB)?$/i.exec(value);
  if (!m) return NaN;
  const unit = (m[2] ?? 'B').toLowerCase();
  const mult = { b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }[unit];
  return Number(m[1]) * mult;
};

describe('reverse proxy config (deploy/caddy)', () => {
  const config = caddyConfig();
  const site = caddyText('deploy/caddy/Caddyfile');
  const upstream = caddyText('deploy/caddy/upstream.caddy.tmpl');

  test('every HSTS header has max-age of at least 15552000, and both HTTPS modes send it (Req 11.6)', () => {
    const hsts = [...config.matchAll(/header\s+Strict-Transport-Security\s+"([^"]*)"/gi)].map(m => m[1]);
    expect(hsts.length).toBeGreaterThan(0);
    for (const value of hsts) {
      const age = /^max-age=(\d+)\b/.exec(value);
      expect(age).not.toBeNull();
      expect(Number(age[1])).toBeGreaterThanOrEqual(15552000);
    }
    for (const mode of ['deploy/caddy/tls-file.caddy', 'deploy/caddy/tls-internal.caddy']) {
      expect(caddyText(mode)).toMatch(/header\s+Strict-Transport-Security\s+"max-age=\d+"/);
    }
  });

  test('request_body max_size is set to 4 MiB or less (Req 17.11)', () => {
    const sizes = [...config.matchAll(/max_size\s+(\S+)/g)].map(m => m[1]);
    expect(site).toMatch(/request_body\s*\{[^}]*max_size\s+\S+/);
    for (const size of sizes) {
      const bytes = caddyBytes(size);
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  test('no Access-Control-* header is set (Req 12.6)', () => {
    expect(config).not.toMatch(/Access-Control-/i);
  });

  test('the proxy does not answer OPTIONS requests itself (Req 12.6)', () => {
    expect(config).not.toMatch(/OPTIONS/i);
    expect(config).not.toMatch(/\bmethod\b/);
  });

  test('every request goes to the App_Server and no file is served from disk (Req 20.8)', () => {
    expect(config).not.toMatch(/^\s*(root|file_server|try_files|browse)\b/m);
    expect(site).toMatch(/handle\s*\{\s*import\s+\/etc\/caddy\/upstream\.caddy\s*\}/);
    expect(upstream).toMatch(/^reverse_proxy\s+app-__COLOR__:\d+\s*\{/m);
    // Dot-prefixed paths are refused by the App_Server's static allowlist (tests/http.test.js).
  });

  test('client-sent forwarding headers are overwritten before they reach the App_Server (Req 9.12)', () => {
    expect(upstream).toMatch(/header_up\s+X-Forwarded-For\s+\{remote_host\}/);
    expect(upstream).toMatch(/header_up\s+X-Forwarded-Proto\s+\{scheme\}/);
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

  test('the runtime stage copies only the build output and production node_modules, never the whole context (Req 20.6)', () => {
    expect(runtime.name).toBe('runtime');
    const copies = runtime.instrs.filter(i => i.op === 'COPY' || i.op === 'ADD');
    expect(copies.length).toBeGreaterThan(0);
    expect(runtime.instrs.some(i => i.op === 'ADD')).toBe(false);
    // main's build stage bundles server/ into /out (scripts/build-server.mjs); src/ and tests/ never reach the image.
    const allowed = { build: new Set(['/out/']), 'prod-deps': new Set(['/src/node_modules']) };
    for (const copy of copies) {
      const from = /--from=(\S+)/.exec(copy.args)?.[1];
      expect(Object.keys(allowed)).toContain(from);
      const sources = copy.args.split(/\s+/).filter(p => !p.startsWith('--')).slice(0, -1);
      expect(sources.length).toBeGreaterThan(0);
      for (const src of sources) {
        expect(['.', './', '/', '/src', '/src/'].includes(src)).toBe(false);
        expect(allowed[from].has(src)).toBe(true);
      }
    }
  });

  test('ENTRYPOINT and CMD start Bun without inspector, hot reload, or watch flags (Req 19.5)', () => {
    const cmds = stages.flatMap(s => s.instrs).filter(i => i.op === 'CMD' || i.op === 'ENTRYPOINT');
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) expect(cmd.args).not.toMatch(/--(inspect(-brk|-wait)?|hot|watch)\b/);
    expect(runtime.instrs.find(i => i.op === 'ENTRYPOINT').args).toMatch(/^\[\s*"bun"\s*,\s*"\/app\/server\/serve\.js"\s*\]$/);
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

// ---------- deploy/compose ----------

const COMPOSE_FILES = filesIn('deploy/compose', /\.ya?ml$/);
const ENV_EXAMPLES = [...filesIn('deploy/compose', /\.env\.example$/), ...(existsSync(join(ROOT, '.env.example')) ? ['.env.example'] : [])];

describe('deploy/compose', () => {
  test('has the production compose file and environment examples', () => {
    expect(COMPOSE_FILES).toContain('deploy/compose/compose.yaml');
    expect(ENV_EXAMPLES.length).toBeGreaterThan(0);
  });

  test('environment, build args, and labels set no secret value; secrets come from ${VAR} or *_FILE (Req 14.5)', () => {
    const bad = [];
    for (const file of COMPOSE_FILES) {
      lines(read(file)).forEach((line, i) => {
        const m = /^\s*-?\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^"'#]*?)["']?\s*$/.exec(line);
        if (!m) return;
        const pair = { name: m[1], value: m[2].trim() };
        if (!pair.value || !SECRET_NAME.test(pair.name) || /_FILE$/i.test(pair.name)) return;
        if (/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-)?\}$/.test(pair.value)) return; // ${VAR} or ${VAR:-} with an empty default
        bad.push(`${file}:${i + 1} ${pair.name}`);
      });
    }
    expect(bad).toEqual([]);
  });

  test('the OpenAI key is provided only as a key file, never as an environment value (Req 14.6)', () => {
    // environment may be a map or a KEY=value list; a bare KEY passes the caller's value through.
    const entries = env => Array.isArray(env)
      ? env.map(s => { const i = String(s).indexOf('='); return i < 0 ? [String(s), undefined] : [String(s).slice(0, i), String(s).slice(i + 1)]; })
      : Object.entries(env ?? {}).map(([k, v]) => [k, v === null || v === undefined ? undefined : String(v)]);
    const bad = [];
    let keySeen = 0;
    for (const file of COMPOSE_FILES) {
      for (const [svc, def] of Object.entries(YAML.parse(read(file)).services ?? {})) {
        for (const [key, value] of entries(def.environment)) {
          if (key === 'CAMPING_OPENAI_API_KEY') {
            keySeen++;
            if (value !== '') bad.push(`${file} services.${svc} sets CAMPING_OPENAI_API_KEY`);
          }
          if (key === 'CAMPING_OPENAI_API_KEY_FILE' && !(value === '' || value === '${CAMPING_OPENAI_API_KEY_FILE:-}' || /^\/run\/secrets\/[A-Za-z0-9_.-]+$/.test(value ?? ''))) {
            bad.push(`${file} services.${svc} CAMPING_OPENAI_API_KEY_FILE is not empty or a /run/secrets/ path`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // The App services pin the key to the empty string, so app.env or <env>.env cannot supply it.
    expect(keySeen).toBeGreaterThan(0);
    for (const file of ENV_EXAMPLES) expect(read(file)).not.toMatch(/^\s*CAMPING_OPENAI_API_KEY\s*=/m);
  });
});

// ---------- environment examples ----------

describe('environment examples', () => {
  test('give every secret variable an empty value or an angle-bracket placeholder (Req 14.7)', () => {
    const bad = [];
    for (const file of ENV_EXAMPLES) {
      lines(read(file)).forEach((line, i) => {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || !SECRET_NAME.test(m[1])) return;
        const value = m[2].trim().replace(/^["']|["']$/g, '');
        if (value !== '' && !/^<[^<>]+>$/.test(value)) bad.push(`${file}:${i + 1} ${m[1]}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

// ---------- Secret_Scanner rules over configuration files ----------

test('Dockerfile, deploy/compose, environment examples, and deploy/caddy match no Secret_Scanner rule (Req 14.9, 14.10)', () => {
  const findings = [];
  for (const file of ['Dockerfile', ...COMPOSE_FILES, ...ENV_EXAMPLES, ...CADDY_FILES]) {
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
