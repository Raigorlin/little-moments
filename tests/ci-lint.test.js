// 設定 lint（tasks 16.1；design.md「測試策略」）：以讀檔方式檢查設定檔，不執行 Docker、Jenkins 或 Compose。
//
//   * Dockerfile 與 ci/build-image/Dockerfile 每個 FROM 以 `@sha256:` 固定（Req 3.1、16.3）
//   * Jenkinsfile 與 ci/jenkins/pipelines/*.Jenkinsfile 的 BUILD_IMAGE 以 digest 引用（Req 3.1）
//   * .dockerignore 含設計列出的全部排除項目（Req 16.7、15.5）
//   * Jenkinsfile 無可略過 Release_Gate 的參數、環境變數或選項（Req 23.4）
//   * deploy/compose 的 db 不發布連接埠（Req 11.10）
//   * CAMPING_BEDROCK_* 預設為空字串（Req 15.6）
//
// 本檔只針對上列需求做彙整檢查；各 Pipeline 的細部結構檢查在 ci-jenkinsfile／ci-build-image-pipeline 等測試中。
// sha256:<digest> PLACEHOLDER 在這裡視為合格的固定形式：未取代時映像解析失敗（fail closed），
// 由 infra/build-image 的 Validate 與各 Pipeline 的 Init 階段另行拒絕。

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// ---------------------------------------------------------------------------
// Dockerfile FROM 解析
// ---------------------------------------------------------------------------

// digest 只接受 64 個小寫十六進位字元，或尚未取代的 PLACEHOLDER `<digest>`。
const DIGEST = /^sha256:(?:[0-9a-f]{64}|<digest>)$/;

/**
 * 解析一行 Dockerfile 指令；不是 FROM 時回傳 null。
 * 支援 `FROM [--platform=<p>] <image> [AS <name>]`（關鍵字不分大小寫）。無法解析的 FROM 回傳 { invalid: true }。
 */
function parseFrom(line) {
  const m = /^\s*FROM\s+(.*?)\s*$/i.exec(line);
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  let platform = null;
  while (tokens[0]?.startsWith('--')) {
    const flag = tokens.shift();
    const p = /^--platform=(\S+)$/.exec(flag);
    if (!p) return { invalid: true };
    platform = p[1];
  }
  const image = tokens.shift();
  let alias = null;
  if (tokens.length === 2 && /^as$/i.test(tokens[0])) alias = tokens[1];
  else if (tokens.length !== 0) return { invalid: true };
  if (!image) return { invalid: true };
  const at = image.indexOf('@');
  const digest = at === -1 ? null : image.slice(at + 1);
  return { platform, image, name: at === -1 ? image : image.slice(0, at), digest, alias };
}

/** Dockerfile 中所有 FROM（略過註解與 parser directive 行）。 */
function fromLines(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => ({ line: l.trim(), from: parseFrom(l) }))
    .filter((x) => x.from);
}

/** 違反固定規則的 FROM：外部映像必須 `@sha256:`；只允許引用先前已定義的階段名稱。 */
function unpinnedFroms(text) {
  const stages = new Set();
  const bad = [];
  for (const { line, from } of fromLines(text)) {
    if (from.invalid) { bad.push(line); continue; }
    const isStage = from.digest === null && stages.has(from.image.toLowerCase());
    if (!isStage && !(from.digest !== null && DIGEST.test(from.digest))) bad.push(line);
    if (from.alias) stages.add(from.alias.toLowerCase());
  }
  return bad;
}

describe('Dockerfile FROM 以 @sha256: 固定（Req 3.1、16.3）', () => {
  for (const file of ['Dockerfile', 'ci/build-image/Dockerfile']) {
    test(file, () => {
      const text = read(file);
      const froms = fromLines(text);
      expect(froms.length).toBeGreaterThan(0);
      expect(unpinnedFroms(text)).toEqual([]);
      // 至少一個外部映像，且每個外部映像都帶 @sha256:（不接受只有 tag，例如 :latest）。
      const external = froms.filter((f) => f.from.digest !== null);
      expect(external.length).toBeGreaterThan(0);
      for (const f of external) expect(f.from.image).toMatch(/@sha256:/);
      // 不以 ARG 取代基底映像（無法靜態確認 digest）。
      for (const f of froms) expect(f.from.image).not.toContain('$');
    });
  }

  test('解析器：可變 tag、未定義階段、ARG 映像與多餘 token 皆判定為未固定', () => {
    const d = 'a'.repeat(64);
    const ok = [
      `FROM oven/bun:1.3.0@sha256:${d} AS deps`,
      'FROM deps AS build',
      `FROM --platform=linux/amd64 registry.lan:8443/x/y@sha256:<digest>`,
    ].join('\n');
    expect(unpinnedFroms(ok)).toEqual([]);
    for (const bad of [
      'FROM oven/bun:1.3.0',
      'FROM oven/bun:latest AS x',
      'FROM build AS later',
      'FROM ${BASE_IMAGE}',
      `FROM oven/bun@sha256:${'A'.repeat(64)}`,
      `FROM oven/bun@sha256:${d} AS a extra`,
      `FROM --pull=always oven/bun@sha256:${d}`,
    ]) {
      expect(unpinnedFroms(bad)).toEqual([bad]);
    }
    // 註解中的 FROM 不納入。
    expect(fromLines('# FROM oven/bun:latest\n')).toEqual([]);
  });

  test('性質：任意 platform／映像名稱／digest／別名組成的 FROM 行可正確解析並判定為已固定', () => {
    const seg = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/);
    const tag = fc.option(fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,15}$/), { nil: null });
    const digest = fc.oneof(fc.stringMatching(/^[0-9a-f]{64}$/), fc.constant('<digest>'));
    const alias = fc.option(fc.stringMatching(/^[a-z][a-z0-9_-]{0,9}$/), { nil: null });
    const platform = fc.option(fc.constantFrom('linux/amd64', 'linux/arm64', '$BUILDPLATFORM'), { nil: null });
    const kw = fc.constantFrom('FROM', 'from', 'From');
    const as = fc.constantFrom('AS', 'as');
    fc.assert(fc.property(fc.array(seg, { minLength: 1, maxLength: 3 }), tag, digest, alias, platform, kw, as,
      (path, t, dg, al, pf, k, a) => {
        const name = path.join('/') + (t ? `:${t}` : '');
        const image = `${name}@sha256:${dg}`;
        const line = `  ${k} ${pf ? `--platform=${pf} ` : ''}${image}${al ? ` ${a} ${al}` : ''}  `;
        const parsed = parseFrom(line);
        expect(parsed).toEqual({ platform: pf, image, name, digest: `sha256:${dg}`, alias: al });
        expect(unpinnedFroms(line)).toEqual([]);
        // 去掉 digest 後即為未固定。
        expect(unpinnedFroms(line.replace(`@sha256:${dg}`, ''))).toHaveLength(1);
      }));
  });
});

// ---------------------------------------------------------------------------
// Jenkinsfile
// ---------------------------------------------------------------------------

const PIPELINE_DIR = 'ci/jenkins/pipelines';
const pipelineFiles = ['Jenkinsfile', ...readdirSync(resolve(root, PIPELINE_DIR)).filter((f) => f.endsWith('.Jenkinsfile')).map((f) => `${PIPELINE_DIR}/${f}`)];

/**
 * 移除 Groovy 的整行 `//` 註解與行首開始的 `/* *\/` 區塊註解。只處理行首，
 * 避免誤刪 sh 腳本內的 `"$registry"/*@sha256:*)` 或 URL 中的 `//`。
 */
function stripComments(text) {
  return text
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

describe('Build_Image 以 digest 引用（Req 3.1）', () => {
  test('ci/jenkins/pipelines 至少包含 build-image、digest-lookup、restore-drill、rollback', () => {
    for (const f of ['build-image', 'digest-lookup', 'restore-drill', 'rollback']) {
      expect(pipelineFiles).toContain(`${PIPELINE_DIR}/${f}.Jenkinsfile`);
    }
  });

  for (const file of pipelineFiles) {
    test(file, () => {
      const code = stripComments(read(file));
      // environment 區塊內的宣告（整行 `BUILD_IMAGE = '...'`）；字串內的 `'BUILD_IMAGE = ' + ref` 不算。
      const refs = [...code.matchAll(/^\s*BUILD_IMAGE\s*=\s*(['"])([^'"]*)\1\s*$/gm)].map((m) => m[2]);
      // infra/build-image 自己產生 Build_Image，不以 BUILD_IMAGE 執行；其他 Pipeline 都必須定義。
      if (!file.endsWith('build-image.Jenkinsfile')) expect(refs.length).toBe(1);
      for (const ref of refs) {
        expect(ref).toMatch(/^[a-z0-9][a-z0-9.-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:(?:[0-9a-f]{64}|<digest>)$/);
      }
      // 不以可變 tag 拉取 Build_Image（docker.image(...) 只接受 env.BUILD_IMAGE）。
      for (const m of code.matchAll(/docker\.image\(([^)]*)\)/g)) expect(m[1].trim()).toBe('env.BUILD_IMAGE');
    });
  }
});

// 會略過、強制通過或放寬關卡的名稱片段（以 `_`／`-` 或駝峰分隔的單字比對）。
const BYPASS_WORDS = ['SKIP', 'BYPASS', 'OVERRIDE', 'FORCE', 'IGNORE', 'WAIVE', 'NOGATE', 'NOGATES', 'ALLOWFAIL', 'ALLOWFAILURE', 'UNSAFE', 'DISABLE'];
// Jenkins 內建的選項名稱（與 Release_Gate 無關）。
const ALLOWED_OPTIONS = new Set(['skipDefaultCheckout', 'timestamps', 'disableResume']);

function hasBypassWord(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().split(/[_-]+/);
  const joined = words.join('');
  return words.some((w) => BYPASS_WORDS.includes(w)) || ['NOGATE', 'ALLOWFAIL', 'SKIPGATE'].some((w) => joined.includes(w));
}

describe('Jenkinsfile 無可略過 Release_Gate 的參數、環境變數或選項（Req 23.4）', () => {
  const code = stripComments(read('Jenkinsfile'));
  const block = (name) => {
    const start = code.search(new RegExp(`^\\s*${name}\\s*\\{`, 'm'));
    if (start === -1) return null;
    let depth = 0;
    for (let i = code.indexOf('{', start); i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) return code.slice(code.indexOf('{', start) + 1, i);
    }
    return null;
  };

  test('沒有 parameters 區塊、input 參數或 params. 讀取', () => {
    expect(code).not.toMatch(/\bparameters\b/);
    expect(code).not.toMatch(/\bparams\b/);
  });

  test('options 只含 Jenkins 內建選項', () => {
    const opts = [...(block('options') ?? '').matchAll(/\b([A-Za-z]+)\s*\(/g)].map((m) => m[1]);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(ALLOWED_OPTIONS.has(o)).toBe(true);
  });

  test('environment 區塊與 env.* 讀取的變數名稱不含略過／強制／放寬字詞', () => {
    const envBlock = block('environment');
    expect(envBlock).not.toBeNull();
    const declared = [...envBlock.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]);
    expect(declared).toContain('BUILD_IMAGE');
    const reads = [...code.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const shell = [...code.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
    const names = [...new Set([...declared, ...reads, ...shell])];
    expect(names.filter(hasBypassWord)).toEqual([]);
  });

  test('關卡判讀工具不讀取環境變數，也沒有略過或強制通過的命令列選項', () => {
    for (const file of ['ci/gates.mjs', 'ci/policy/evaluate.mjs', 'ci/policy/normalize.mjs']) {
      const src = read(file);
      expect(src).not.toMatch(/process\.env|Bun\.env|import\.meta\.env/);
      const flags = [...src.matchAll(/['"`]--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
      expect(flags.filter(hasBypassWord)).toEqual([]);
    }
  });

  test('名稱判定：略過類名稱會被偵測，一般名稱不會', () => {
    for (const n of ['SKIP_GATES', 'LM_SKIP_SECURITY', 'bypassGate', 'FORCE_DEPLOY', 'LM_NO_GATE', 'allow-failure', 'IGNORE_DAST']) {
      expect(hasBypassWord(n)).toBe(true);
    }
    for (const n of ['BUILD_IMAGE', 'LM_IMAGE_REPO', 'LM_REL_GATES_OK', 'GIT_COMMIT_FULL', 'summary-out']) {
      expect(hasBypassWord(n)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// .dockerignore
// ---------------------------------------------------------------------------

describe('.dockerignore（Req 16.7、15.5）', () => {
  // design.md Components §11 列出的全部項目（含 Req 16.7 的必要項目）。
  const REQUIRED = [
    'data/', '.env*', 'tests/', 'node_modules/', '.git/', '*.log', '*.sqlite*', 'test-results/', 'playwright-report/',
    'previews/', 'reports/', '.kiro/', '*.pem', '*.key', '*.p12', '*.pfx', '*.crt',
  ];

  test('含設計列出的全部排除項目，且沒有以 `!` 重新納入', () => {
    const entries = read('.dockerignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const e of REQUIRED) expect(entries).toContain(e);
    expect(entries.filter((e) => e.startsWith('!'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const COMPOSE_FILES = ['deploy/compose/compose.yaml', 'deploy/compose/drill.yaml'];
const parseCompose = (file) => YAML.parse(read(file));

/** environment 可為 map 或 `KEY=value` 清單；統一為 [key, value]。 */
function envEntries(environment) {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment.map((s) => {
      const i = String(s).indexOf('=');
      return i === -1 ? [String(s), undefined] : [String(s).slice(0, i), String(s).slice(i + 1)];
    });
  }
  return Object.entries(environment).map(([k, v]) => [k, v === null ? undefined : String(v)]);
}

describe('Compose：db 不發布連接埠（Req 11.10）', () => {
  for (const file of COMPOSE_FILES) {
    test(file, () => {
      const db = parseCompose(file).services?.db;
      expect(db).toBeDefined();
      expect(db.ports).toBeUndefined();
      expect(db.expose).toBeUndefined();
      expect(db.network_mode).toBeUndefined();
      expect(db.image).toMatch(/@sha256:(?:[0-9a-f]{64}|<digest>)$/);
    });
  }
});

describe('CAMPING_BEDROCK_* 預設為空字串（Req 15.6）', () => {
  const NAMES = ['CAMPING_BEDROCK_REGION', 'CAMPING_BEDROCK_MODEL_ID', 'CAMPING_BEDROCK_API_KEY'];

  for (const file of COMPOSE_FILES) {
    test(file, () => {
      const services = parseCompose(file).services ?? {};
      let seen = 0;
      for (const [svc, def] of Object.entries(services)) {
        for (const [key, value] of envEntries(def.environment)) {
          if (!key.startsWith('CAMPING_BEDROCK_')) continue;
          seen++;
          // 只接受空字串，或由同名 Compose 變數帶入且預設為空字串的 `${NAME:-}`／`${NAME-}`。
          const ok = value === '' || value === `\${${key}:-}` || value === `\${${key}-}`;
          if (!ok) throw new Error(`${file} services.${svc}.environment.${key} 的預設值不是空字串：${value}`);
        }
      }
      // 執行 App 的服務都必須明確設定三個變數（不依賴映像或 env_file）。
      const appServices = Object.entries(services).filter(([, d]) => !d.entrypoint && d.user === '10001:10001');
      expect(appServices.length).toBeGreaterThan(0);
      for (const [, d] of appServices) {
        const keys = envEntries(d.environment).map(([k]) => k);
        for (const n of NAMES) expect(keys).toContain(n);
      }
      expect(seen).toBeGreaterThan(0);
    });
  }

  test('Compose 變數範本（*.env.example）中 CAMPING_BEDROCK_* 為空值', () => {
    const dir = 'deploy/compose';
    const files = readdirSync(resolve(root, dir)).filter((f) => f.endsWith('.env.example'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const line of read(`${dir}/${f}`).split(/\r?\n/)) {
        const m = /^\s*(CAMPING_BEDROCK_[A-Z_]+)\s*=(.*)$/.exec(line);
        if (m) expect([m[1], m[2].trim()]).toEqual([m[1], '']);
      }
    }
    for (const env of ['staging', 'prod']) {
      const text = read(`${dir}/${env}.env.example`);
      for (const n of NAMES) expect(text).toMatch(new RegExp(`^${n}=$`, 'm'));
    }
  });

  test('Pipeline 不以非空值設定 CAMPING_BEDROCK_*', () => {
    for (const file of pipelineFiles) {
      const code = stripComments(read(file));
      for (const m of code.matchAll(/CAMPING_BEDROCK_[A-Z_]+\s*[=:]\s*(\S*)/g)) {
        expect(m[1].replace(/^['"]{2}$/, '')).toBe('');
      }
    }
  });
});
