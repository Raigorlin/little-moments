// Jenkinsfile 骨架的靜態檢查（Req 1.1、1.6、3.1、3.3、3.4、3.6、22.1、23.4；Rust + Supabase 版：plan.md D1–D16）。
// 本機沒有 Jenkins／Groovy，這裡只檢查結構與關鍵字，不能取代 Jenkins 的實際語法驗證。
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { STAGE } from '../ci/stages.mjs';
import { recordPatch, toolchainRecord } from '../ci/verify-toolchain.mjs';
import { createRecord, mergeRecord, validateRecord } from '../ci/record.mjs';

const root = resolve(import.meta.dir, '..');
const source = readFileSync(resolve(root, 'Jenkinsfile'), 'utf8');

/** 移除註解與字串內容（保留引號本身），只留下 Groovy 結構供括號與關鍵字檢查。 */
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('//')) { const n = text.indexOf('\n', i); i = n < 0 ? text.length : n; continue; }
    if (rest.startsWith('/*')) { const n = text.indexOf('*/', i + 2); if (n < 0) throw new Error('未結束的區塊註解'); i = n + 2; continue; }
    const quote = rest.startsWith("'''") ? "'''" : rest.startsWith('"""') ? '"""' : (rest[0] === "'" || rest[0] === '"') ? rest[0] : null;
    if (quote) {
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++;
        if (quote.length === 1 && text[j] === '\n') throw new Error(`第 ${text.slice(0, i).split('\n').length} 行字串未結束`);
        j++;
      }
      if (j >= text.length) throw new Error('未結束的字串');
      out += quote + quote;
      i = j + quote.length;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

const structure = stripCommentsAndStrings(source);
const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('Jenkinsfile 結構', () => {
  test('括號在註解與字串之外成對且順序正確', () => {
    const pairs = { ')': '(', '}': '{', ']': '[' };
    const stack = [];
    for (const ch of structure) {
      if ('({['.includes(ch)) stack.push(ch);
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch]);
    }
    expect(stack).toEqual([]);
  });

  test('Declarative pipeline 只有一個 pipeline 區塊，且 options 含必要選項', () => {
    expect(structure.match(/^pipeline\s*\{/gm)?.length).toBe(1);
    const options = /options\s*\{([^}]*)\}/.exec(structure)?.[1] ?? '';
    for (const opt of ['skipDefaultCheckout()', 'timestamps()', 'disableResume()']) expect(options).toContain(opt);
  });

  test('不提供任何建置參數，也沒有任何 input 步驟（Req 23.4；plan.md D1：合併到 main 即發布）', () => {
    expect(structure).not.toMatch(/\bparameters\s*[{(]/);
    expect(structure).not.toMatch(/\bparams\./);
    expect(code).not.toMatch(/\binput\s*\(/);
    expect(code).not.toMatch(/submitter/);
  });

  test('Build_Image 以 @sha256: digest 引用（Req 3.1）', () => {
    const ref = /BUILD_IMAGE\s*=\s*'([^']+)'/.exec(source)?.[1];
    expect(ref).toBeDefined();
    expect(ref).toMatch(/@sha256:/);
    expect(ref).not.toMatch(/:latest\b/);
    expect(code).toContain('docker.image(env.BUILD_IMAGE)');
  });

  test('checkout scm 後以 git rev-parse HEAD 固定 Commit SHA（Req 1.6）', () => {
    const checkout = code.indexOf('checkout scm');
    const revParse = code.indexOf("'git rev-parse HEAD'");
    expect(checkout).toBeGreaterThan(-1);
    expect(revParse).toBeGreaterThan(checkout);
    expect(code.match(/checkout scm/g)?.length).toBe(1);
  });

  test('階段名稱屬於 ci/stages.mjs，順序與 main 的規劃相同（plan.md D1）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    const known = new Set(Object.values(STAGE));
    for (const n of names) expect(known.has(n)).toBe(true);
    const { planStages } = await import('../ci/stages.mjs');
    expect(names).toEqual(planStages({ event: 'push', ref: 'main' }).stages.filter((n) => n !== STAGE.NOTIFY));
    expect(names.slice(0, 6)).toEqual([STAGE.INIT, STAGE.TOOLCHAIN, STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.SECURITY]);
    // enterStage 名稱與 stage 名稱一致。
    expect([...code.matchAll(/enterStage\('([^']+)'\)/g)].map((m) => m[1])).toEqual(names);
  });

  test('pending 通知、Build_Record、工具鏈驗證都在安裝之前；建置在安裝之後（Req 3.3、3.6、21.1、22.1）', () => {
    const at = (s) => { const i = code.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
    const install = at('bun install --frozen-lockfile\n');
    expect(at("notifyAll('pending'")).toBeLessThan(install);
    expect(at('bun ci/record.mjs init')).toBeLessThan(install);
    expect(at('bun ci/verify-toolchain.mjs')).toBeLessThan(install);
    expect(at('sh ci/verify-rust-toolchain.sh')).toBeLessThan(install);
    expect(at("'cargo build --workspace --locked'")).toBeGreaterThan(install);
    expect(at("'trunk build --release --config crates/web/Trunk.toml'")).toBeGreaterThan(install);
  });

  test('只使用 --frozen-lockfile 安裝，不執行會修改 bun.lock 的指令（Req 3.4）', () => {
    for (const m of code.matchAll(/bun install[^\n]*/g)) expect(m[0]).toContain('--frozen-lockfile');
    expect(code).not.toMatch(/\bbun (add|update|remove|pm)\b/);
    expect(code).not.toMatch(/\b(npm|yarn|pnpm) /);
  });

  test('憑證只以 withCredentials 綁定，不使用 environment 的 credentials()（Req 15.1）', () => {
    expect(code).not.toMatch(/credentials\(/);
    const ids = [...code.matchAll(/credentialsId:/g)].length;
    const bound = [...code.matchAll(/withCredentials\(\[/g)].length;
    expect(ids).toBeGreaterThan(0);
    expect(bound).toBe(ids);
  });
});

/** 取出 stage('name') 區塊的原始碼（到下一個 stage 或輔助函式區段為止）。 */
function stageBlock(name) {
  const start = code.indexOf(`stage('${name}')`);
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.search(/stage\('|\n\/\/ -{10,}|\nvoid |\nint |\nString |\nboolean |\nMap |\nList |\ndef /);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/** 取出 Groovy 函式本體（以括號配對）。 */
function functionBody(signature) {
  const start = code.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const open = code.indexOf('{', start + signature.length);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error(`找不到 ${signature} 的結尾`);
}

/**
 * stage 的完整內容：stage 宣告（stageBlock：when、steps、post）加上它呼叫的階段函式與 post 函式本體。
 * Components 第 22 節起，各 stage 的 steps 與多於一個敘述的 post 內容位於 pipeline {} 之後的頂層函式
 * （run<階段名稱>Stage()、<階段>Post<條件>()）；順序為 stage 宣告 → run…Stage() → post 函式。
 */
function stageCode(name) {
  const block = stageBlock(name);
  const fns = [...block.matchAll(/script \{ (run\w+Stage|[a-z]\w*Post(?:Always|Unsuccessful|Cleanup))\(\) \}/g)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith('pipelinePost'));
  expect(fns[0]).toMatch(/^run\w+Stage$/);
  return [block, ...fns.map((f) => functionBody(`void ${f}()`))].join('\n');
}

/** 所有 ''' 多行 sh 腳本（含以位置參數傳給 runScan 的腳本）。 */
const tripleScripts = [...source.matchAll(/(?:script: |, )'''([\s\S]*?)'''/g)].map((m) => m[1]);

/** Groovy 單引號字串的跳脫：`\` + 換行為續行，其餘 `\x` 依 Groovy 規則轉換（與 ci-jenkinsfile-shell-env.test.js 相同）。 */
function groovyUnescape(raw) {
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  return raw.replace(/\\(\n|.)/g, (_, c) => (c === '\n' ? '' : (map[c] ?? c)));
}

/** 有 git 的 POSIX sh：Linux 優先 dash；Windows 經 WSL（同樣優先 dash）。回傳 { prefix, sh, toPath, label } 或 null。 */
function findPosixShell() {
  const ok = (cmd, args) => spawnSync(cmd, args, { timeout: 60_000, encoding: 'utf8' }).status === 0;
  const probe = 'command -v git >/dev/null 2>&1';
  if (process.platform === 'win32') {
    for (const sh of ['dash', 'sh']) {
      if (!ok('wsl.exe', ['-e', sh, '-c', probe])) continue;
      const toPath = (p) => {
        const r = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', p.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60_000 });
        if (r.status !== 0) throw new Error(`wslpath 失敗：${r.stderr}`);
        return r.stdout.trim();
      };
      return { prefix: ['wsl.exe', '-e'], sh, toPath, label: `WSL ${sh}` };
    }
    return null;
  }
  for (const sh of ['dash', 'sh']) if (ok(sh, ['-c', probe])) return { prefix: [], sh, toPath: (p) => p, label: sh };
  return null;
}

/**
 * 「Gitleaks history range」腳本的測試驅動（POSIX sh）：參數為 <sh> <腳本> 之後每三個一組
 * （LM_SCAN_BASE_REF、LM_GITLEAKS_HISTORY_BASE、GIT_PREVIOUS_SUCCESSFUL_COMMIT）。在臨時 repository 建立
 * A–B–C–D（refs/heads/main）與自 A 分岔的 X（refs/heads/side），以 env -i 只傳入指定變數執行腳本（-e，cwd 為 repository），
 * 每組輸出一行 `out=<stdout>`。符號：A–D、X 為 SHA；EMPTY 為空字串（LM_SCAN_BASE_REF 為 EMPTY 時不設定）；
 * UNSET 為不設定；SHORT 不是 40 hex；UPPER 為 B 的大寫；MISSING 為不存在的 40 hex。
 */
const RANGE_DRIVER = `set -eu
sh_bin="$1"; script="$2"; shift 2
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
git init -q "$t/repo"
cd "$t/repo"
tree="$(git mktree </dev/null)"
A="$(git commit-tree -m A "$tree")"
B="$(git commit-tree -p "$A" -m B "$tree")"
C="$(git commit-tree -p "$B" -m C "$tree")"
D="$(git commit-tree -p "$C" -m D "$tree")"
X="$(git commit-tree -p "$A" -m X "$tree")"
git update-ref refs/heads/main "$D"
git update-ref refs/heads/side "$X"
printf 'A=%s\\nB=%s\\nC=%s\\nD=%s\\nX=%s\\n' "$A" "$B" "$C" "$D" "$X"
val() {
  case "$1" in
    A) printf '%s' "$A" ;; B) printf '%s' "$B" ;; C) printf '%s' "$C" ;; D) printf '%s' "$D" ;; X) printf '%s' "$X" ;;
    EMPTY) ;;
    SHORT) printf '%s' abc123 ;;
    UPPER) printf '%s' "$B" | tr a-f A-F ;;
    MISSING) printf '%s' 0123456789abcdef0123456789abcdef01234567 ;;
    *) printf '%s' "$1" ;;
  esac
}
while [ $# -ge 3 ]; do
  ref="$1"; base="$2"; prev="$3"; shift 3
  vars="GIT_COMMIT_FULL=$D"
  [ "$ref" = EMPTY ] || vars="$vars LM_SCAN_BASE_REF=$ref"
  [ "$base" = UNSET ] || vars="$vars LM_GITLEAKS_HISTORY_BASE=$(val "$base")"
  [ "$prev" = UNSET ] || vars="$vars GIT_PREVIOUS_SUCCESSFUL_COMMIT=$(val "$prev")"
  out="$(env -i PATH="$PATH" HOME="$t" $vars "$sh_bin" -e "$script")" || { echo "script failed: $ref $base $prev" >&2; exit 1; }
  printf 'out=%s\\n' "$out"
done
`;

/** 文字中所有 docker run／create 指令（含以 `\` 續行的參數）。 */
function dockerRunsIn(text) {
  return [...text.matchAll(/docker (?:run|create)\b((?:[^\n]*\\\n)*[^\n]*)/g)].map((m) => m[1]);
}

describe('Rust 工具鏈、Install、Build 與 Unit Tests（plan.md D3、D15；Req 3、4、23.1、23.5）', () => {
  const toolchain = stageCode(STAGE.TOOLCHAIN);
  const install = stageCode(STAGE.INSTALL);
  const build = stageCode(STAGE.BUILD);
  const unit = stageCode(STAGE.UNIT);
  const buildRust = functionBody('void buildRustToolchain()');
  const inRust = functionBody('def inRustToolchain(boolean network, Closure body)');
  const recordQa = functionBody('int recordQa(Map args)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };

  test('所有 sh 腳本皆為單引號字串，不經 Groovy 插值', () => {
    expect(code).not.toMatch(/script:\s*"/);
    expect(code).not.toMatch(/\bsh\s*\(?\s*"/);
    expect(code).not.toMatch(/script:\s*"""/);
  });

  test('docker run 不發布連接埠、不使用 host 網路、不以 -v 掛載；唯一的具名卷是 cargo 快取（Req 2.6；plan.md D3）', () => {
    for (const cmd of dockerRunsIn(source)) {
      expect(cmd).not.toMatch(/\s(-p|--publish|--publish-all|-P)(\s|=)/);
      expect(cmd).not.toMatch(/\s(-v|--volume)(\s|=)/);
      for (const m of cmd.matchAll(/--mount "?type=volume,([^"\s]+)/g)) expect(m[1]).toBe('src=$LM_CARGO_VOLUME,dst=/cargo-cache');
    }
    expect(code).not.toMatch(/--network[ =]host/);
    expect(code).not.toMatch(/--publish/);
    expect([...code.matchAll(/docker volume create ([^\n]+)/g)].map((m) => m[1].trim())).toEqual(['"$LM_CARGO_VOLUME" > /dev/null || exit 30']);
    // Ephemeral_Database、Browser Tests、Migration Compatibility 與 DAST 已移除（plan.md D14、D15）。
    for (const gone of ['startEphemeralDb', 'inBuildImageOn', 'LM_EDB_', 'check-accounts.mjs', 'qa-inventory', 'zap.sh', 'ci/dast/', 'scripts/migrate.mjs', 'image-smoke-seed']) {
      expect({ gone, found: code.includes(gone) }).toEqual({ gone, found: false });
    }
  });

  test('Rust 工具鏈映像：根目錄 Dockerfile 的 toolchain 階段、空的建置內容、本機標籤；cargo 快取卷依信任等級分開', () => {
    inOrder(buildRust, [
      "env.LM_RUST_TOOLCHAIN_IMAGE = \"${env.LM_RUST_TOOLCHAIN_IMAGE_REPO}:${env.GIT_COMMIT_FULL}\".toString()",
      "env.LM_CARGO_VOLUME = \"${env.LM_CARGO_CACHE_VOLUME}-${env.LM_TRUSTED == 'true' ? 'release' : 'ci'}\".toString()",
      'ctx="$WORKSPACE_TMP/lm-rust-toolchain-context"', 'mkdir -m 0700 "$ctx"',
      'docker build --target toolchain --file "$WORKSPACE/Dockerfile"', '--label "lm.ci.build=$BUILD_TAG" --tag "$LM_RUST_TOOLCHAIN_IMAGE" "$ctx"',
      'docker volume create "$LM_CARGO_VOLUME"', '--entrypoint chown "$LM_RUST_TOOLCHAIN_IMAGE" "$(id -u):$(id -g)" /cargo-cache',
    ]);
    const [chown] = dockerRunsIn(buildRust);
    for (const flag of ['--rm', '--network none', '--user 0:0', '--cap-drop ALL --cap-add CHOWN', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"']) {
      expect(chown).toContain(flag);
    }
    expect(buildRust).toMatch(/rc != 0\) \{\s*error\(/);
    expect(/LM_RUST_TOOLCHAIN_IMAGE_REPO = '([^']+)'/.exec(source)?.[1]).toBe('lm-rust-toolchain');
    expect(/LM_CARGO_CACHE_VOLUME = '([^']+)'/.exec(source)?.[1]).toBe('lm-cargo-cache');
    // Dockerfile 有 toolchain 階段，且其中沒有 COPY（空的建置內容即可建置）。
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const stage = dockerfile.slice(dockerfile.search(/^FROM \S+ AS toolchain$/m), dockerfile.search(/^FROM \S+ AS build$/m));
    expect(stage.length).toBeGreaterThan(0);
    expect(stage).not.toMatch(/^(COPY|ADD) /m);
  });

  test('inRustToolchain：離線時 --network none、CARGO_NET_OFFLINE／TRUNK_OFFLINE；只有 Install 的 cargo fetch 可連網', () => {
    expect(inRust).toContain("String args = (network ? '' : '--network none ') + \"--mount type=volume,src=${env.LM_CARGO_VOLUME},dst=/cargo-cache\"");
    expect(inRust).toContain('docker.image(env.LM_RUST_TOOLCHAIN_IMAGE).inside(args)');
    for (const v of ["'CARGO_HOME=/cargo-cache'", '"CARGO_TARGET_DIR=${env.WORKSPACE}/target"', '"CARGO_NET_OFFLINE=${offline}"', '"TRUNK_OFFLINE=${offline}"', '"HOME=${env.WORKSPACE_TMP}/home"']) {
      expect(inRust).toContain(v);
    }
    expect(inRust).toContain("String offline = network ? 'false' : 'true'");
    const calls = [...code.matchAll(/inRustToolchain\((true|false)\)/g)].map((m) => m[1]);
    expect(calls.filter((c) => c === 'true')).toHaveLength(1);
    expect(install).toContain('inRustToolchain(true)');
    for (const block of [toolchain, build, unit]) {
      expect(block).toContain('inRustToolchain(false)');
      expect(block).not.toContain('inRustToolchain(true)');
    }
  });

  test('Toolchain：Bun 工具鏈 → Rust 工具鏈映像 → verify-rust-toolchain.sh；版本寫入 Build_Record 後才判定（Req 3.3）', () => {
    inOrder(toolchain, [
      'bun ci/verify-toolchain.mjs --out reports/toolchain.json', 'buildRustToolchain()',
      'sh ci/verify-rust-toolchain.sh --expected ci/rust-toolchain.json --out reports/rust-toolchain.json',
      "rustToolchain: 'reports/rust-toolchain.json'", 'mergeRecordPatch(', 'if (rustRc != 0)',
    ]);
    expect(toolchain).toMatch(/if \(rustRc != 0\) \{\s*error\('Rust 工具鏈版本與 ci\/rust-toolchain\.json 不一致/);
  });

  test('Install：bun install --frozen-lockfile 與 cargo fetch --locked，lockfile 被修改即失敗（Req 3.4、3.5）', () => {
    inOrder(install, ['bun install --frozen-lockfile', 'inRustToolchain(true)', 'before="$(sha256sum Cargo.lock)"', 'cargo fetch --locked\n', 'after="$(sha256sum Cargo.lock)"']);
    expect(install).toContain('Cargo.lock 在 cargo fetch 期間被修改，安裝中止');
    // 每個 cargo 指令都帶 --locked（fmt 除外，它不解析相依）；沒有會修改 Cargo.lock 的指令。
    for (const m of code.matchAll(/\bcargo (build|test|clippy|fetch) (?=-)[^\n]*/g)) expect(m[0]).toContain('--locked');
    expect(code).not.toMatch(/\bcargo (update|add|remove|generate-lockfile|install)\b/);
  });

  test('Build：cargo build --workspace --locked → trunk build --release（Req 3.6、3.7）', () => {
    inOrder(build, ['inRustToolchain(false)', "script: 'cargo build --workspace --locked'", "script: 'trunk build --release --config crates/web/Trunk.toml'"]);
    expect(build).not.toContain('bun run build');
  });

  test('Unit Tests：fmt → clippy -D warnings → cargo test → bats → cargo-junit → bun test →「QA」關卡（plan.md D15）', () => {
    inOrder(unit, [
      'inRustToolchain(false)', 'cargo fmt --all --check > reports/cargo-fmt.log', 'cargo clippy --workspace --locked -- -D warnings > reports/cargo-clippy.log',
      'timeout --kill-after=30 1800 cargo test --workspace --locked > reports/cargo-test.log', 'timeout --kill-after=30 900 bats --report-formatter junit --output reports/bats deploy/tests',
      'inBuildImage {', 'bun ci/cargo-junit.mjs --log reports/cargo-test.log --out reports/cargo-junit.xml --exit "$LM_CARGO_TEST_EXIT"',
      'timeout --kill-after=30 900 bun test --reporter=junit --reporter-outfile=reports/unit-junit.xml ${LM_BUN_TESTS}',
      'if (cargoRc != 0 || batsRc != 0 || testRc != 0)', 'recordQa(patch:',
    ]);
    // fmt 與 clippy 未通過時以指名該檢查的固定訊息失敗。
    expect(unit).toMatch(/if \(fmtRc != 0\) \{\s*error\('cargo fmt --all --check 未通過/);
    expect(unit).toMatch(/if \(clippyRc != 0\) \{\s*error\('cargo clippy --workspace --locked -- -D warnings 未通過/);
    expect(unit).toMatch(/Release_Gate「QA」未通過/);
    // cargo test 與 bats 在無網路的工具鏈映像內；bun test 在 Build_Image 內。
    const rustPart = unit.slice(unit.indexOf('inRustToolchain(false)'), unit.indexOf('inBuildImage {'));
    for (const s of ['cargo fmt', 'cargo clippy', 'cargo test', 'bats ']) expect(rustPart).toContain(s);
    expect(rustPart).not.toContain('bun ');
    expect(functionBody('List qaJunitReports()')).toContain("return ['reports/cargo-junit.xml', 'reports/bats/report.xml', 'reports/unit-junit.xml']");
    expect(unit).toContain("junit(testResults: 'reports/cargo-junit.xml, reports/bats/report.xml, reports/unit-junit.xml', allowEmptyResults: true)");
  });

  test('LM_BUN_TESTS 為 plan.md D15 的清單，且每個項目都對應到存在的測試檔', () => {
    const list = /LM_BUN_TESTS = '([^']+)'/.exec(source)?.[1].split(' ');
    expect(list).toEqual(['tests/ci-*.test.js', 'tests/deploy-*.test.js', 'tests/schedule-css-parity.test.js', 'tests/storybook-studio-parity.test.js', 'tests/readme.test.js', 'tests/secret-scan.test.js']);
    const files = readdirSync(resolve(root, 'tests'));
    for (const p of list) {
      const re = new RegExp(`^${p.slice('tests/'.length).replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      expect({ p, n: files.filter((f) => re.test(f)).length > 0 }).toEqual({ p, n: true });
    }
  });

  test('「QA」關卡以 ci/gates.mjs 評估並寫入 Build_Record；階段失敗時 post 記錄為未通過（Req 23.1、23.3、23.5）', () => {
    expect(recordQa).toContain('bun ci/gates.mjs junit --gate QA --commit "$GIT_COMMIT_FULL" --out reports/gate-qa.json');
    // Jenkins 不傳空值的環境變數（JENKINS-43632），可能為空的變數以 ${X:-} 展開（Components 第 24.4 節）。
    expect(recordQa).toContain('--stage-error "${LM_GATE_STAGE_ERROR:-}"');
    expect(recordQa).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-qa.json');
    expect(recordQa).toContain('bun ci/record.mjs merge --record "$LM_RECORD"');
    const post = functionBody('void unitTestsPostAlways()');
    inOrder(post, ["junit(testResults:", "if (env.LM_QA_GATE_RECORDED == 'true') { return }", 'recordQa(', "stageError: qaStageError('Unit Tests')"]);
    expect(stageBlock(STAGE.UNIT)).toMatch(/always\s*\{\s*script\s*\{\s*unitTestsPostAlways\(\)/);
    const keys = Object.fromEntries([...functionBody('Map unitReports()').matchAll(/(\w+): '(reports\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(keys).sort()).toEqual(['batsJunit', 'batsLog', 'cargoClippy', 'cargoFmt', 'cargoJunit', 'cargoTest', 'unitJunit']);
    const rec = createRecord({
      job: 'ci/little-moments/rust', number: 1, url: 'https://jenkins.invalid/job/1/',
      commit: 'a'.repeat(40), trigger: 'branch_push', ref: 'rust', buildImageDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(validateRecord(mergeRecord(rec, { reports: keys })).ok).toBe(true);
  });
});

describe('Security Scan 階段（Req 6.1–6.9、23.1、23.3、23.5）', () => {
  const sec = stageCode('Security Scan');
  const prepare = functionBody('void prepareScanSources()');
  const runScan = functionBody('void runScan(String what, String report, String script)');
  const recordGate = functionBody('int recordSecurityGate(String stageError)');
  const gateFn = functionBody('Map securityGate(String evaluationText, List scanErrors, String stageError, String commit, List reports)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const scanRuns = [...dockerRunsIn(sec), ...dockerRunsIn(functionBody('void scannerVersions()'))];

  test('位於 Unit Tests 之後；依序 Gitleaks（dir、git）→ osv-scanner（bun.lock、Cargo.lock）→ Trivy → Semgrep → normalize → evaluate → 關卡', () => {
    expect(code.indexOf("stage('Security Scan')")).toBeGreaterThan(code.indexOf("stage('Unit Tests')"));
    const order = [
      'pullImages(scannerImages())', 'prepareScanSources()', 'scannerVersions()',
      "'gitleaks-dir.json'", "'gitleaks-git.json'", "'osv.json'", "'osv-cargo.json'", "'trivy-node-modules.json'", "'semgrep.json'",
      'bun ci/policy/normalize.mjs', 'bun ci/policy/evaluate.mjs', "recordSecurityGate('')",
    ].map((s) => at(sec, s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sec).toMatch(/recordSecurityGate\(''\) != 0\)\s*\{\s*error\(/);
  });

  test('掃描器映像以 LAN Registry 的 @sha256: digest 固定，且於拉取前驗證（Req 3.1、6.8）', () => {
    for (const name of ['LM_GITLEAKS_IMAGE', 'LM_OSV_SCANNER_IMAGE', 'LM_TRIVY_IMAGE', 'LM_SEMGREP_IMAGE']) {
      const ref = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1];
      expect(ref).toMatch(/^registry\.our-littlemoments\.com:8443\/[^@\s]+@sha256:[0-9a-f]{64}$/);
      expect(functionBody('List scannerImages()')).toContain(`env.${name}`);
    }
    expect(functionBody('List scannerImages()')).toContain('isPinnedImage(s)');
    expect(functionBody('String buildImageDigest()')).toContain('isPinnedImage(ref)');
  });

  test('Gitleaks：受版本控制檔案（dir）與 Git 歷史（git --log-opts），一律 --redact、JSON 報告、無 verbose（Req 6.1、6.4）', () => {
    const gitleaks = scanRuns.filter((c) => c.includes('"$LM_GITLEAKS_IMAGE"') && !c.includes(' version'));
    expect(gitleaks.length).toBe(2);
    const [dir, git] = gitleaks;
    expect(dir).toMatch(/"\$LM_GITLEAKS_IMAGE"\s*\\\n\s*dir /);
    expect(git).toMatch(/"\$LM_GITLEAKS_IMAGE"\s*\\\n\s*git /);
    expect(git).toContain('--log-opts="$LM_GITLEAKS_LOG_OPTS" /repo');
    for (const cmd of gitleaks) {
      expect(cmd).toMatch(/\s--redact\s/);
      expect(cmd).toContain('--report-format json');
      expect(cmd).toContain('--exit-code 0');
      expect(cmd).not.toMatch(/\s(-v|--verbose)\b/);
      expect(cmd).toContain('--network none');
    }
    // 受版本控制檔案以暫存 index 取出（不套用 export-ignore）；repo 內的掃描器設定／忽略檔不生效。
    expect(prepare).toContain('git read-tree "$GIT_COMMIT_FULL"');
    expect(prepare).toContain('git checkout-index --all --force --prefix="$LM_SCAN_DIR/tree/"');
    for (const f of ['.gitleaks.toml', '.gitleaksignore', 'osv-scanner.toml', '.semgrepignore', '.trivyignore']) expect(prepare).toContain(f);
    expect(prepare).toContain('git init -q --bare "$LM_SCAN_DIR/history.git"');
    // Gitleaks 原始報告不保留（只保留 normalize 後不含秘密的結果）。
    expect(sec).toContain('rm -f "$LM_SCAN_DIR/out/gitleaks-dir.json" "$LM_SCAN_DIR/out/gitleaks-git.json"');
  });

  test('Git 歷史範圍：Untrusted_PR 用 merge base，其他從 LM_GITLEAKS_HISTORY_BASE 或其後已驗證的 GIT_PREVIOUS_SUCCESSFUL_COMMIT 開始，沒有完整歷史（Req 6.1、6.10）', () => {
    // Secret_History_Baseline：environment 恰有一個 40 個小寫十六進位字元的常數，不是建置參數、不經 params.* 或 withEnv 覆寫（Req 23.4）。
    const environment = functionBody('  environment {');
    expect(environment.match(/^\s*LM_GITLEAKS_HISTORY_BASE\s*=\s*'[0-9a-f]{40}'\s*$/gm)?.length).toBe(1);
    expect(code.match(/\bLM_GITLEAKS_HISTORY_BASE\s*=\s*'/g)?.length).toBe(1);
    expect(/LM_GITLEAKS_HISTORY_BASE\s*=\s*'([^']+)'/.exec(environment)?.[1]).toBe('65df54e514b3da26a0b8c8535648c22d1e870919');
    expect(structure).not.toMatch(/\bparameters\s*[{(]/);
    expect(code).not.toMatch(/params\.[\w.?]*LM_GITLEAKS_HISTORY_BASE|params\[\s*['"]LM_GITLEAKS_HISTORY_BASE/);
    expect(code).not.toMatch(/LM_GITLEAKS_HISTORY_BASE=|env\.LM_GITLEAKS_HISTORY_BASE\s*=/);
    expect(prepare).toContain('floor="${LM_GITLEAKS_HISTORY_BASE:-}"');
    expect(prepare).toContain('git merge-base --is-ancestor "$floor" "$head"');
    expect(prepare).toContain('git merge-base --is-ancestor "$floor" "$prev"');
    // 不再有只輸出 $head 的完整歷史分支（Jenkinsfile 原文的 '%s\\n'）。
    expect(prepare).not.toContain(String.raw`printf '%s\\n' "$head"`);
    // 非 PR 失敗時的固定訊息（不含任何 SHA 或其他值）。
    expect(prepare).toContain("'Gitleaks（Git 歷史）無法決定掃描範圍（LM_GITLEAKS_HISTORY_BASE 無效或不是建置 commit 的祖先），歷史掃描未完成'");
    expect(prepare).toContain("env.LM_TRIGGER_KIND == 'pull_request'");
    expect(prepare).toContain('validBranchName(target)');
    // 非 PR 建置時兩者皆為空、Jenkins 不傳給 sh（Components 第 24.4 節），以 ${X:-} 展開。
    expect(prepare).toContain('git merge-base "${LM_SCAN_BASE_REF:-}" "$head"');
    expect(prepare).toContain("'refs/remotes/origin/' + target");
    expect(prepare).toContain('"+refs/heads/${LM_SCAN_FETCH_TARGET:-}:refs/remotes/origin/${LM_SCAN_FETCH_TARGET:-}"');
    // "LM_SCAN_FETCH_TARGET=${target}" 的空值來自前一行的三元運算，tests/ci-jenkinsfile-shell-env.test.js 的規則 1 無法辨識，在此固定。
    expect(prepare).toContain('if [ -n "${LM_SCAN_FETCH_TARGET:-}" ]; then');
    expect(prepare).toContain('git fetch --unshallow');
    expect(prepare).toContain("grep -Eqx '[0-9a-f]{40}'");
    expect(prepare).toContain('git merge-base --is-ancestor "$prev" "$head"');
    expect(prepare).toContain('${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}');
    // Groovy 端再驗證範圍格式，PR 必須是 base..head，且結尾必須是建置 commit。
    expect(prepare).toContain('range ==~ /^[0-9a-f]{40}\\.\\.[0-9a-f]{40}$/');
    expect(prepare).toContain('range ==~ /^([0-9a-f]{40}\\.\\.)?[0-9a-f]{40}$/');
    expect(prepare).toContain('range.endsWith(sha)');
    // 無法決定範圍 → 歷史掃描未完成（記錄原因），關卡未通過。
    expect(prepare).toMatch(/LM_GITLEAKS_LOG_OPTS = ''\s*\n\s*lmScanErrors << /);
    expect(functionBody('boolean validBranchName(String name)')).toContain("!name.contains('..')");
  });

  // 腳本行為（design.md Components 第 27.6 節）：在臨時 repository 建立 A–B–C–D 與自 A 分岔的 X，
  // 執行 Jenkinsfile 的「Gitleaks history range」腳本。Windows 經 WSL 的 dash／sh；沒有 POSIX sh 時略過。
  const SH = findPosixShell();
  const describeSh = SH ? describe : describe.skip;
  describeSh(SH ? `Gitleaks history range 腳本（${SH.label}、git）` : 'Gitleaks history range 腳本（略過：找不到 POSIX sh 與 git）', () => {
    const m = /label: 'Gitleaks history range', returnStdout: true, script: '''([\s\S]*?)'''/.exec(prepare);
    const rangeScript = groovyUnescape(m?.[1] ?? '').replace(/\r/g, '');
    // 每個案例：名稱、LM_SCAN_BASE_REF、LM_GITLEAKS_HISTORY_BASE、GIT_PREVIOUS_SUCCESSFUL_COMMIT（符號在 WSL 端換成 SHA；UNSET 表示不設定）。
    const cases = {
      'prev 為空': ['', 'B', 'UNSET'],
      'prev 為空字串': ['', 'B', ''],
      'prev 為起點的後代': ['', 'B', 'C'],
      'prev 等於起點': ['', 'B', 'B'],
      'prev 比起點舊': ['', 'B', 'A'],
      'prev 不是 head 的祖先': ['', 'B', 'X'],
      'prev 不是 40 hex': ['', 'B', 'SHORT'],
      'prev 不存在': ['', 'B', 'MISSING'],
      '起點不是 40 hex': ['', 'SHORT', 'C'],
      '起點為大寫十六進位': ['', 'UPPER', 'C'],
      '起點未設定': ['', 'UNSET', 'C'],
      '起點不存在': ['', 'MISSING', 'C'],
      '起點不是 head 的祖先': ['', 'X', 'C'],
      '起點等於 head（空範圍）': ['', 'D', 'UNSET'],
      'PR：merge base 分支不變': ['refs/heads/side', 'MISSING', 'C'],
      'PR：取不到 merge base': ['refs/heads/nope', 'B', 'C'],
    };
    const expected = {
      'prev 為空': 'B..D', 'prev 為空字串': 'B..D', 'prev 為起點的後代': 'C..D', 'prev 等於起點': 'B..D',
      'prev 比起點舊': 'B..D', 'prev 不是 head 的祖先': 'B..D', 'prev 不是 40 hex': 'B..D', 'prev 不存在': 'B..D',
      '起點不是 40 hex': '', '起點為大寫十六進位': '', '起點未設定': '', '起點不存在': '', '起點不是 head 的祖先': '',
      '起點等於 head（空範圍）': 'D..D', 'PR：merge base 分支不變': 'A..D', 'PR：取不到 merge base': '',
    };
    let results = null;
    let shas = null;
    function runAll() {
      if (results) return;
      const dir = mkdtempSync(join(tmpdir(), 'lm-gitleaks-range-'));
      try {
        writeFileSync(join(dir, 'range.sh'), rangeScript);
        writeFileSync(join(dir, 'driver.sh'), RANGE_DRIVER);
        const names = Object.keys(cases);
        const args = names.flatMap((n) => cases[n]);
        const argv = [...SH.prefix, SH.sh, SH.toPath(join(dir, 'driver.sh')), SH.sh, SH.toPath(join(dir, 'range.sh')),
          ...args.map((a) => (a === '' ? 'EMPTY' : a))];
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000 });
        expect({ status: r.status, stderr: r.stderr ?? '' }).toEqual({ status: 0, stderr: '' });
        const lines = r.stdout.replace(/\r/g, '').split('\n');
        shas = Object.fromEntries(lines.filter((l) => /^[ABCDX]=/.test(l)).map((l) => l.split('=')));
        const outs = lines.filter((l) => l.startsWith('out=')).map((l) => l.slice(4));
        expect(outs.length).toBe(names.length);
        results = Object.fromEntries(names.map((n, i) => [n, outs[i]]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const sub = (s) => s.replace(/\b[ABCDX]\b/g, (c) => shas[c]);

    test('腳本取出成功且含起點的檢查', () => {
      expect(rangeScript).toContain('floor="${LM_GITLEAKS_HISTORY_BASE:-}"');
      expect(rangeScript).not.toMatch(/printf '%s\\n' "\$head"/);
    });
    for (const name of Object.keys(cases)) {
      test(`${name} → ${expected[name] || '沒有輸出（歷史掃描未完成）'}`, () => {
        runAll();
        expect(Object.keys(shas).sort()).toEqual(['A', 'B', 'C', 'D', 'X']);
        expect(results[name]).toBe(expected[name] ? sub(expected[name]) : '');
      });
    }
  });

  test('osv-scanner v2（bun.lock 與 Cargo.lock 各一份報告、--all-packages）、Trivy node_modules 交叉掃描、Semgrep（ci/semgrep/run.sh）（Req 6.2、6.3）', () => {
    expect(sec).toContain('scan source --lockfile=/src/bun.lock --all-packages --format json --output-file "/out/$LM_SCAN_REPORT"');
    expect(sec).toContain('scan source --lockfile=/src/Cargo.lock --all-packages --format json --output-file "/out/$LM_SCAN_REPORT"');
    expect(sec).toContain("runScan('osv-scanner（Cargo.lock）', 'osv-cargo.json', '''");
    // 兩次掃描使用同一個以 digest 固定的映像，容器名稱不同；缺少 Cargo.lock 時掃描未完成（結束碼 3）。
    const osvRuns = scanRuns.filter((c) => c.includes('"$LM_OSV_SCANNER_IMAGE"') && !c.includes('-version-'));
    expect(osvRuns.map((c) => /--name "([^"]+)"/.exec(c)?.[1])).toEqual(['$LM_SCAN_RUN-osv-scanner', '$LM_SCAN_RUN-osv-scanner-cargo']);
    expect(sec).toMatch(/if \[ ! -f "\$LM_SCAN_DIR\/tree\/Cargo\.lock" \]; then\s*\n\s*echo "找不到 Cargo\.lock" >&2\s*\n\s*exit 3/);
    // Cargo.lock 是受版本控制檔案（掃描輸入 tree/ 由 git checkout-index 取出）。
    expect(existsSync(resolve(root, 'Cargo.lock'))).toBe(true);
    expect(sec).toContain('rootfs --scanners vuln --list-all-pkgs --format json --output "/out/$LM_SCAN_REPORT"');
    expect(sec).toContain('--mount "type=bind,src=$WORKSPACE/node_modules,dst=/scan/node_modules,readonly"');
    expect(sec).toContain('--db-repository "$LM_TRIVY_DB_REPOSITORY"');
    expect(sec).toContain('ci/semgrep/run.sh scan "/out/$LM_SCAN_REPORT"');
    // ci/semgrep/run.sh 的用法與此一致。
    expect(readFileSync(resolve(root, 'ci/semgrep/run.sh'), 'utf8')).toContain('ci/semgrep/run.sh scan <out.json>');
  });

  test('每項掃描 15 分鐘逾時；錯誤、逾時或缺少輸入時刪除報告並記錄未完成（Req 6.8）', () => {
    const scans = scanRuns.filter((c) => !c.includes('-version-'));
    expect(scans.length).toBe(6);
    expect([...sec.matchAll(/timeout --kill-after=30 900 docker run /g)].length).toBe(6);
    expect(runScan).toContain("timeout(time: 17, unit: 'MINUTES')");
    expect(runScan).toMatch(/rc != 0\)\s*\{\s*discardScan\(\)/);
    expect(runScan).toMatch(/catch \(Exception e\)\s*\{[\s\S]*discardScan\(\)\s*\n\s*throw e/);
    expect(functionBody('void discardScan()')).toContain('rm -f "$LM_SCAN_DIR/out/$LM_SCAN_REPORT"');
    // 只有兩次 osv-scanner（1 = 有漏洞）與 Semgrep（1 = 有結果）把結束碼 1 視為完成；其他非零皆為未完成。
    expect([...sec.matchAll(/if \[ "\$rc" -eq 1 \]; then rc=0; fi/g)].length).toBe(3);
    // 評估無法執行（結束碼 2）也記錄為未完成。
    expect(sec).toMatch(/evalRc != 0 && evalRc != 1\)\s*\{\s*lmScanErrors << /);
  });

  test('工具版本：只有 Semgrep 關閉版本檢查；60 秒逾時、|| true 與取不到版本時為 null 的處理不變（Req 6.7、6.8）', () => {
    const versions = functionBody('void scannerVersions()');
    const calls = versions.split('\n').map((l) => l.trim()).filter((l) => /^v [a-z-]+ /.test(l));
    expect(calls).toEqual([
      'v gitleaks "$LM_GITLEAKS_IMAGE" version',
      'v osv-scanner "$LM_OSV_SCANNER_IMAGE" --version',
      'v trivy "$LM_TRIVY_IMAGE" --version',
      'v semgrep -e SEMGREP_ENABLE_VERSION_CHECK=0 --entrypoint semgrep "$LM_SEMGREP_IMAGE" --version',
    ]);
    expect([...versions.matchAll(/SEMGREP_ENABLE_VERSION_CHECK/g)].length).toBe(1);
    expect([...versions.matchAll(/timeout --kill-after=10 60 docker run /g)].length).toBe(1);
    expect(versions).toContain('--network none "$@" 2>/dev/null');
    expect(versions).toContain('| head -n 1 > "$LM_SCAN_DIR/out/$tool.version" || true');
    expect(versions).toMatch(/\n\s*exit 0\n/);
    // 版本步驟在 secStep('無法取得掃描工具版本') 與 secStep('') 之間（步驟失敗時記錄為掃描未完成）。
    expect(sec).toMatch(/secStep\('無法取得掃描工具版本'\)\s*\n\s*scannerVersions\(\)\s*\n\s*secStep\(''\)/);
  });

  test('掃描器容器：非 root、唯讀根檔案系統、--cap-drop ALL、no-new-privileges、建置標籤；寫入只限掃描暫存目錄', () => {
    expect(scanRuns.length).toBe(7);
    for (const cmd of scanRuns) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.scan=$LM_SCAN_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).toMatch(/--network (none|bridge)\b/);
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) {
        const writable = !m[1].endsWith(',readonly');
        if (writable) expect(m[1]).toMatch(/^type=bind,src=\$LM_SCAN_DIR\/[a-z-]+,dst=\/(out|cache)$/);
      }
    }
    // 只有需要漏洞資料庫的 osv-scanner 與 Trivy 可連網。
    const networked = scanRuns.filter((c) => c.includes('--network bridge'));
    expect(networked.map((c) => /"\$(LM_\w+_IMAGE)"/.exec(c)?.[1]).sort()).toEqual(['LM_OSV_SCANNER_IMAGE', 'LM_OSV_SCANNER_IMAGE', 'LM_TRIVY_IMAGE']);
  });

  test('拉取帳號只在 withCredentials 內、經 set +x 腳本與 docker -e NAME 傳遞（Req 15.1、15.2）', () => {
    // pullImages、Trivy（node_modules）、Trivy（App_Image）、Staging 部署前 cosign verify，
    // 與唯讀 Registry 操作（releaseRegistry：版本標籤查詢、Production 部署前 cosign verify）五個腳本使用拉取帳號。
    const regScripts = tripleScripts.filter((s) => /LM_REG_PASSWORD|TRIVY_PASSWORD/.test(s));
    expect(regScripts.length).toBe(5);
    for (const s of regScripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
    expect(sec).toContain('-e TRIVY_USERNAME -e TRIVY_PASSWORD');
    expect(sec).not.toMatch(/-e TRIVY_PASSWORD=/);
    expect(sec).toMatch(/withCredentials\(\[usernamePassword\([\s\S]*?runScan\('Trivy/);
  });

  test('normalize／evaluate 參數與 CLI 一致；「安全」關卡寫入 Build_Record，階段失敗時 post 記錄未通過（Req 6.7、23.1、23.3、23.5）', () => {
    const specs = /for spec in ([^;]+);/.exec(sec)?.[1].trim().split(/\s+/) ?? [];
    expect(specs.map((s) => s.split(':')[0])).toEqual(['gitleaks', 'gitleaks', 'osv-scanner', 'osv-scanner', 'trivy', 'semgrep']);
    expect(specs[3]).toBe('osv-scanner:osv-cargo');
    // 原始報告（不含秘密）也保留 Cargo.lock 的 osv-scanner 結果。
    expect(sec).toContain('for name in osv osv-cargo trivy-node-modules semgrep; do');
    const evalReports = /--reports ([^\\\n]+)/.exec(sec)?.[1].trim().split(/\s+/) ?? [];
    expect(evalReports).toEqual(specs.map((s) => `reports/security/${s.split(':')[1]}.json`));
    expect(sec).toContain('--exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_SCAN_TODAY"');
    // 寫入 Build_Record 的步驟在 writeSecurityGate，路徑經環境變數傳入。
    expect(recordGate).toContain("writeSecurityGate(reports, 'reports/security/evaluation.json', errors, stageError,");
    expect(recordGate).toContain("'reports/gate-security.json', 'reports/security-record-patch.json')");
    const writeGate = functionBody('int writeSecurityGate(Map reports, String evaluationPath, List errors, String stageError, String gateFile, String patchFile)');
    expect(writeGate).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_SECURITY_GATE_FILE"');
    expect(writeGate).toContain('bun ci/record.mjs merge --record "$LM_RECORD" --patch "$LM_SECURITY_GATE_PATCH"');
    expect(writeGate).toContain('"LM_SECURITY_GATE_FILE=${gateFile}", "LM_SECURITY_GATE_PATCH=${patchFile}"');
    expect(writeGate).toMatch(/rc != 0\)\s*\{\s*error\(/);
    expect(gateFn).toContain("gate: '安全'");
    expect(gateFn).toMatch(/failedRun \|\| !incomplete\.isEmpty\(\)\)\s*\{\s*status = 'error'/);
    expect(sec).toMatch(/LM_SECURITY_GATE_RECORDED != 'true'[\s\S]*recordSecurityGate\(secStageError\(\)\)/);
    expect(sec).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupSecurityScan\(\)/);
    // Build_Record 報告鍵通過白名單。
    const keys = Object.fromEntries([...recordGate.matchAll(/(\w+): '(reports\/security\/[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(keys).sort()).toEqual(['gitleaks', 'gitleaksHistory', 'osv', 'osvCargo', 'securityEvaluation', 'semgrep', 'trivyNodeModules']);
    expect(keys.osvCargo).toBe('reports/security/osv-cargo.json');
    const rec = createRecord({
      job: 'ci/little-moments/PR-1', number: 1, url: 'https://jenkins.invalid/job/1/',
      commit: 'a'.repeat(40), trigger: 'pull_request', ref: 'PR-1', buildImageDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(validateRecord(mergeRecord(rec, { reports: keys })).ok).toBe(true);
  });
});

describe('main 專用的映像階段：Image Build → Image Scan → SBOM → Image Push → Image Sign（Req 15.1–15.3、16、17.1–17.6、21.2）', () => {
  const IMAGE_STAGES = [STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN];
  const blocks = Object.fromEntries(IMAGE_STAGES.map((n) => [n, stageCode(n)]));
  const build = blocks[STAGE.IMAGE_BUILD];
  const scan = blocks[STAGE.IMAGE_SCAN];
  const sbom = blocks[STAGE.SBOM];
  const push = blocks[STAGE.IMAGE_PUSH];
  const sign = blocks[STAGE.IMAGE_SIGN];
  const prepare = functionBody('void prepareImageWork()');
  const gateFn = functionBody('Map imageGate(String phase, String evaluationText, List errors, String stageError, String commit, List reports, Map facts)');
  const recordGate = functionBody('int recordImageGate(String phase, String stageError, boolean recordPass)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 1, url: 'https://jenkins.invalid/job/1/',
    commit: 'a'.repeat(40), trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });

  test('緊接 Security Scan 之後依序執行，且只在 main_push 的 Trusted 規劃中執行（Req 1.3、2.8）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(5, 11)).toEqual([STAGE.SECURITY, ...IMAGE_STAGES]);
    for (const n of IMAGE_STAGES) {
      expect(blocks[n]).toContain(`when {\n        expression { planned('${n}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }`);
      expect(blocks[n]).toMatch(/unsuccessful\s*\{\s*script\s*\{\s*imageStageFailed\('[^']+'\)/);
      expect(blocks[n]).toContain(`imageStageFailed('${n}')`);
    }
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    for (const n of IMAGE_STAGES) expect(TRUSTED_ONLY_STAGES).toContain(n);
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.slice(main.indexOf(STAGE.IMAGE_BUILD), main.indexOf(STAGE.IMAGE_SIGN) + 1)).toEqual(IMAGE_STAGES);
    expect(main.indexOf(STAGE.SECURITY)).toBeLessThan(main.indexOf(STAGE.IMAGE_BUILD));
    // Tag 事件被拒絕；PR 與其他分支（含 rust、手動重跑）沒有任何映像階段（Req 2.8；plan.md D1）。
    for (const t of [{ event: 'tag', ref: 'v1.2.3' }, { event: 'push', ref: 'rust' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature', manual: true }]) {
      for (const n of IMAGE_STAGES) expect(planStages(t).stages).not.toContain(n);
    }
    expect(sign).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupImageWork\(\)/);
  });

  test('Image Build：QA 與安全關卡通過後才建置；build-image.sh → image-smoke.sh，皆不使用憑證（Req 16.1、16.8、16.9）', () => {
    inOrder(build, [
      'requireQaAndSecurityPassed()', "env.LM_IMAGE_GATE_ELIGIBLE = 'true'", 'pullImages(imageToolImages())', 'prepareImageWork()',
      'bash ci/scripts/build-image.sh --commit "$GIT_COMMIT_FULL" --repo "$LM_IMAGE_REPO" --reports reports',
      "readFile('reports/image-ref.txt')", 'bash ci/scripts/image-smoke.sh --image "$LM_IMAGE_REF" --postgres-image "$LM_POSTGRES_IMAGE"',
    ]);
    const req = functionBody('void requireQaAndSecurityPassed()');
    for (const f of ['reports/gate-qa.json', 'reports/gate-security.json']) expect(req).toContain(f);
    expect(req).not.toContain('gate-security-dast');
    expect(functionBody('boolean gatePassed(String text, String commit)')).toContain('g.pass == true && String.valueOf(g.commit) == commit');
    expect(build).toMatch(/buildRc == 1\)\s*\{\s*error\(/);
    expect(build).toMatch(/buildRc == 3\)\s*\{\s*error\(/);
    expect(build).toMatch(/smokeRc != 0\)\s*\{\s*error\(/);
    expect(build).toContain('BUN_BIN="$LM_IMG_DIR/bin/bun" TMPDIR="$LM_IMG_DIR/tmp"');
    // 建置日誌不論成敗都寫入 Build_Record（Req 16.8）。
    expect(build).toMatch(/always\s*\{\s*script\s*\{\s*recordImageReports\('reports\/image-build-record-patch\.json', \[\s*imageBuildLog: 'reports\/image-build\.log'/);
    // 腳本用法與實作一致。
    const buildScript = readFileSync(resolve(root, 'ci/scripts/build-image.sh'), 'utf8');
    for (const s of ['--commit', '--repo', '--reports', 'BUN_BIN="${BUN_BIN:-bun}"', 'ref_file="${reports_dir}/image-ref.txt"', 'id_file="${reports_dir}/image-id.txt"']) expect(buildScript).toContain(s);
    const smokeScript = readFileSync(resolve(root, 'ci/scripts/image-smoke.sh'), 'utf8');
    for (const s of ['--image|--postgres-image|--runner-image|--reports|--label', 'image-smoke-summary.json']) expect(smokeScript).toContain(s);
    // 建置、掃描與 SBOM 階段沒有推送或簽章憑證（Req 15.2、16.8）。
    for (const b of [build, scan, sbom]) {
      expect(b).not.toMatch(/LM_REGISTRY_PUSH_CREDENTIALS|LM_COSIGN_/);
      expect(b).not.toMatch(/docker push|cosign /);
    }
    expect(build).not.toContain('withCredentials');
  });

  test('BUN_BIN 包裝：無網路的 Build_Image 容器、相同路徑掛載工作目錄與映像工作目錄', () => {
    expect(prepare).toContain("cat > \"$LM_IMG_DIR/bin/bun\" <<'EOF'");
    expect(prepare).toMatch(/\nEOF\n/);
    const [wrapper] = dockerRunsIn(prepare);
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--user "$(id -u):$(id -g)"', '--label "lm.ci.image=$LM_IMG_RUN"', '--entrypoint bun "$BUILD_IMAGE" "$@"', '-w "$PWD"']) {
      expect(wrapper).toContain(flag);
    }
    expect(wrapper).toContain('--mount "type=bind,src=$WORKSPACE,dst=$WORKSPACE"');
    expect(wrapper).toContain('--mount "type=bind,src=$LM_IMG_DIR,dst=$LM_IMG_DIR"');
    expect(prepare).toContain('chmod 0700 "$LM_IMG_DIR"');
    const cleanup = functionBody('void cleanupImageWork()');
    expect(cleanup).toContain('label=lm.ci.image=$LM_IMG_RUN');
    expect(cleanup).toContain('"$WORKSPACE_TMP"/lm-image-*) rm -rf -- "$LM_IMG_DIR" ;;');
  });

  test('映像工具以 LAN Registry 的 @sha256: digest 固定，且於拉取前驗證（Req 3.1、17.3）', () => {
    const tools = functionBody('List imageToolImages()');
    for (const name of ['LM_TRIVY_IMAGE', 'LM_SYFT_IMAGE', 'LM_CRANE_IMAGE', 'LM_COSIGN_IMAGE']) {
      expect(new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1]).toMatch(/^registry\.our-littlemoments\.com:8443\/[^@\s]+@sha256:[0-9a-f]{64}$/);
      expect(tools).toContain(`env.${name}`);
    }
    expect(tools).toContain('isPinnedImage(s)');
    expect(tools).toContain("!repo.startsWith(registry + '/')");
  });

  test('Image Scan：docker save → Trivy image（vuln + secret、15 分鐘）→ normalize → evaluate → 未通過即記錄關卡並停止（Req 17.1–17.3）', () => {
    inOrder(scan, [
      'docker save -o "$LM_IMG_DIR/scan/image.tar" "$LM_IMAGE_REF"', 'withCredentials([usernamePassword(',
      'image --input /scan/image.tar --scanners vuln,secret --list-all-pkgs --format json --output /out/trivy-image.json',
      'bun ci/policy/normalize.mjs --tool trivy --in "$LM_IMG_DIR/out/trivy-image.json" --out reports/security/trivy-image.json',
      'bun ci/policy/evaluate.mjs --reports reports/security/trivy-image.json', "recordImageGate('scan', '', false) != 0",
    ]);
    // Trivy 原始報告（可能含遮罩後的秘密所在行）在正規化後立即刪除，不保存至 Build_Record（Req 17.2）。
    expect(scan).toMatch(/--out reports\/security\/trivy-image\.json \|\| true\n\s*rm -f "\$LM_IMG_DIR\/out\/trivy-image\.json"\n/);
    expect(scan).toContain('credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS');
    expect(scan).toContain('timeout --kill-after=30 900 docker run');
    expect(scan).toContain("timeout(time: 17, unit: 'MINUTES')");
    expect(scan).toContain('--db-repository "$LM_TRIVY_DB_REPOSITORY"');
    expect(scan).toContain('--exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_IMG_TODAY"');
    expect(scan).toMatch(/trivyRc == 124 \|\| trivyRc == 137\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/trivyRc != 0\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/evalRc != 0 && evalRc != 1\)\s*\{\s*lmImageErrors << /);
    expect(scan).toMatch(/recordImageGate\('scan', '', false\) != 0\)\s*\{\s*error\(/);
    // 映像掃描只讀取匯出的 tar，不掛載 docker.sock。
    expect(code).not.toMatch(/docker\.sock/);
  });

  test('SBOM：Syft（無網路、CycloneDX）→ ci/sbom-check.mjs → Build_Record → 「映像」推送前評估（Req 17.4、21.2、23.2）', () => {
    inOrder(sbom, [
      'scan docker-archive:/scan/image.tar --output cyclonedx-json=/out/sbom.cdx.json',
      'bun ci/sbom-check.mjs --in reports/sbom.cdx.json --image-id "$LM_IMAGE_ID" --out reports/sbom-summary.json',
      "[reports: [sbom: 'reports/sbom.cdx.json'", "env.LM_SBOM_OK = 'true'", "recordImageGate('prepush', '', true) != 0",
    ]);
    const [syft] = dockerRunsIn(sbom);
    expect(syft).toContain('--network none');
    expect(sbom).toMatch(/syftRc != 0\)\s*\{[\s\S]*?error\(/);
    expect(sbom).toMatch(/sbomRc != 0\)\s*\{\s*error\(/);
    expect(sbom).toMatch(/recordImageGate\('prepush', '', true\) != 0\)\s*\{\s*error\(/);
  });

  test('SBOM：Syft 的 /tmp tmpfs 為 mode=1777、不使用 --quiet；stderr 寫入 $LM_IMG_DIR/syft.log，失敗時印出最後 20 行後刪除（Design Components 第 28 節、Req 17.4、17.9）', () => {
    const script = /label: 'Syft SBOM', returnStatus: true, script: '''([\s\S]*?)'''/.exec(sbom)?.[1];
    expect(script).toBeDefined();
    const runs = dockerRunsIn(script);
    expect(runs.length).toBe(1);
    const [syft] = runs;
    expect(syft).toContain('"$LM_SYFT_IMAGE"');
    // tmpfs 加上 mode=1777，其餘隔離參數不變（第 28.1 節）。
    expect(syft).toContain('--tmpfs /tmp:rw,nosuid,nodev,size=4g,mode=1777 -e HOME=/tmp -e TMPDIR=/tmp');
    for (const flag of ['--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--network none', '--mount "type=bind,src=$LM_IMG_DIR/scan,dst=/scan,readonly"']) {
      expect(syft).toContain(flag);
    }
    // 不使用 --quiet；stderr 導向映像工作目錄下的 syft.log（不在 reports/ 下，第 28.2 節）。
    expect(script).not.toContain('--quiet');
    expect(syft).toMatch(/scan docker-archive:\/scan\/image\.tar --output cyclonedx-json=\/out\/sbom\.cdx\.json 2> "\$LM_IMG_DIR\/syft\.log" \|\| rc=\$\?$/);
    expect(script).not.toMatch(/reports\/[^\s"]*syft\.log/);
    expect(script).toMatch(/^\s*rm -f "\$LM_IMG_DIR\/out\/sbom\.cdx\.json" reports\/sbom\.cdx\.json reports\/sbom-summary\.json "\$LM_IMG_DIR\/syft\.log"$/m);
    // 失敗（含 rc=3）時印出最後 20 行，之後不論成敗都刪除 syft.log，最後以 rc 結束。
    inOrder(script, [
      '2> "$LM_IMG_DIR/syft.log" || rc=$?', 'rc=3', 'if [ "$rc" -ne 0 ]; then', "echo 'Syft 錯誤輸出（最後 20 行）：'",
      'tail -n 20 "$LM_IMG_DIR/syft.log"', 'rm -f "$LM_IMG_DIR/syft.log"\n', 'exit "$rc"',
    ]);
    expect(script).toMatch(/if \[ "\$rc" -ne 0 \]; then\n\s*echo 'Syft 錯誤輸出（最後 20 行）：'\n\s*tail -n 20 "\$LM_IMG_DIR\/syft\.log" 2>\/dev\/null \|\| true\n\s*fi\n\s*rm -f "\$LM_IMG_DIR\/syft\.log"\n\s*exit "\$rc"\n/);
    // 只修改 Syft：Trivy、crane 與 cosign（以及其他所有 docker run）的 tmpfs 不含 mode=1777（第 28.1 節）。
    const imageRuns = IMAGE_STAGES.flatMap((n) => dockerRunsIn(blocks[n]));
    for (const name of ['LM_TRIVY_IMAGE', 'LM_CRANE_IMAGE', 'LM_COSIGN_IMAGE']) {
      const found = imageRuns.filter((cmd) => cmd.includes(`"$${name}"`));
      expect(found.length).toBe(1);
      expect(found[0]).toMatch(/--tmpfs \/tmp:/);
      expect(found[0]).not.toContain('mode=1777');
    }
    const withMode = dockerRunsIn(code).filter((cmd) => cmd.includes('mode=1777'));
    expect(withMode).toEqual([syft]);
  });

  test('Image Push：拒絕覆寫既有標籤 → docker push → 三方 digest 比對 → image-digest.txt 封存並 fingerprint（Req 16.10、17.5、17.6、21.7）', () => {
    inOrder(push, [
      "env.LM_SBOM_OK != 'true'", "isReleaseTag(env.LM_RELEASE_VERSION ?: '')", 'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS',
      'DOCKER_CONFIG="$LM_IMG_DIR/docker-push"', 'mkdir -m 0700 "$DOCKER_CONFIG"', 'trap ', '--password-stdin "$registry"',
      'crane digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION" > "$out/version-digest.txt"', 'exit 16',
      'crane digest "$LM_IMAGE_REF" > "$out/existing-digest.txt"', 'exit 10', 'grep -Eq \'MANIFEST_UNKNOWN|unexpected status code 404\' "$out/existing-digest.err"',
      'docker push --quiet "$LM_IMAGE_REF"', '{{range .RepoDigests}}', 'remote="$(crane digest "$LM_IMAGE_REF"',
      'by_digest="$(crane digest "$LM_IMAGE_REPO@$digest"', '[ "$remote" != "$digest" ] || [ "$by_digest" != "$digest" ]',
      "printf '%s\\\\n' \"$digest\" > reports/image-digest.txt",
      "image: [digest: digest, tags: [env.GIT_COMMIT_FULL]]", "archiveArtifacts(artifacts: 'reports/image-digest.txt', fingerprint: true)",
    ]);
    expect(push).toContain("trap 'docker logout \"$registry\" > /dev/null 2>&1 || true; rm -rf \"$DOCKER_CONFIG\"' EXIT");
    expect(push).toMatch(/pushRc == 10\)\s*\{\s*error\(/);
    // 版本標籤已存在（版本已發布）時，在推送任何東西之前拒絕（plan.md D2）。
    expect(push).toMatch(/if \(pushRc == 16\) \{[\s\S]*?error\("版本 \$\{env\.LM_RELEASE_VERSION\} 已發布；請先提高 Cargo\.toml 的 \[workspace\.package\] version/);
    expect(push.indexOf('exit 16')).toBeLessThan(push.indexOf('docker push --quiet'));
    expect(push).toMatch(/pushRc != 0\)\s*\{\s*error\(/);
    expect(push).toContain('digestFile != "${digest}\\n".toString()');
    // Registry 只以 Build_Image 所在 LAN Registry 的 repository 引用（標籤為完整 40 字元 SHA，Req 16.6）。
    expect(build).toContain('ref != "${env.LM_IMAGE_REPO}:${env.GIT_COMMIT_FULL}".toString()');
    // fingerprint ID 與 ci/digest-lookup.mjs 相同：MD5(`<digest>\n`)。
    expect(readFileSync(resolve(root, 'ci/digest-lookup.mjs'), 'utf8')).toContain("update(`${digest}\\n`, 'utf8')");
  });

  test('Image Sign：巢狀 withCredentials（推送帳號、cosign 私鑰檔、密碼）→ 以 digest 簽章（--tlog-upload=false）→ 驗證 → 完整「映像」關卡（Req 17.5、17.6）', () => {
    inOrder(sign, [
      "digest ==~ /^sha256:[0-9a-f]{64}$/", 'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS',
      'withCredentials([file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS', 'withCredentials([string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS',
      'ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"', 'cosign sign --yes --key /keys/cosign.key --tlog-upload=false "$ref"',
      'cosign public-key --key /keys/cosign.key --outfile /out/cosign.pub', 'unset COSIGN_PASSWORD',
      'cosign verify --key /out/cosign.pub --insecure-ignore-tlog=true --output json "$ref"',
      "String signatureText = readFile('reports/image-signature.json')", 'signatureCovers(signatureText, digest)', "image: [signature: 'verified']",
      "recordImageGate('final', '', true) != 0",
    ]);
    const [cosign] = dockerRunsIn(sign);
    expect(cosign).toContain('--mount "type=bind,src=$LM_COSIGN_KEY_FILE,dst=/keys/cosign.key,readonly"');
    expect(cosign).toContain('-e COSIGN_PASSWORD ');
    for (const s of [30, 31, 32]) expect(sign).toMatch(new RegExp(`signRc == ${s}\\)\\s*\\{\\s*error\\(`));
    expect(sign).toMatch(/!signatureCovers\([^\n]+\)\)\s*\{\s*error\(/);
    expect(sign).toMatch(/recordImageGate\('final', '', true\) != 0\)\s*\{\s*error\(/);
  });

  test('推送與簽章憑證只在 Image Push／Image Sign 與 staging-verified attestation 的 withCredentials 內；腳本 set +x、不經命令列傳遞秘密（Req 15.1、15.2、15.3）', () => {
    expect(/LM_REGISTRY_PUSH_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-registry-push');
    expect(/LM_COSIGN_KEY_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-key');
    expect(/LM_COSIGN_PASSPHRASE_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-passphrase');
    const uses = (re) => [...code.matchAll(re)].map((m) => m.index);
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    // Staging Deploy 的 attestStaging()（cosign attest 需推送帳號、私鑰與密碼）是第三個使用處；
    // Version Tag 的 pushVersionTag()（crane tag 寫入版本標籤，不需私鑰）是第四個、也是唯一另外的使用處。
    const attest = functionBody('int attestStaging()');
    const versionTag = functionBody('int pushVersionTag()');
    // Components 第 22 節起 withCredentials 隨指令位於 Image Push／Image Sign 的階段函式內（Req 15.2）。
    const pushFn = functionBody('void runImagePushStage()');
    const signFn = functionBody('void runImageSignStage()');
    for (const i of uses(/credentialsId: env\.LM_REGISTRY_PUSH_CREDENTIALS/g)) {
      expect(inside(i, pushFn) || inside(i, signFn) || inside(i, attest) || inside(i, versionTag)).toBe(true);
    }
    expect(uses(/credentialsId: env\.LM_REGISTRY_PUSH_CREDENTIALS/g).length).toBe(4);
    expect(versionTag).not.toMatch(/LM_COSIGN_/);
    for (const re of [/credentialsId: env\.LM_COSIGN_KEY_CREDENTIALS/g, /credentialsId: env\.LM_COSIGN_PASSPHRASE_CREDENTIALS/g]) {
      const found = uses(re);
      expect(found.length).toBe(2);
      expect(inside(found[0], signFn)).toBe(true);
      expect(inside(found[1], attest)).toBe(true);
    }
    const secretScripts = tripleScripts.filter((s) => /LM_PUSH_PASSWORD|COSIGN_PASSWORD|LM_COSIGN_KEY_FILE/.test(s));
    expect(secretScripts.length).toBe(4);
    for (const s of secretScripts) {
      expect(s.trim().split('\n')[0].trim()).toBe('set +x');
      expect(s).toContain("printf '%s' \"$LM_PUSH_PASSWORD\" | docker login --username \"$LM_PUSH_USER\" --password-stdin");
      expect(s).not.toMatch(/echo[^\n]*\$(LM_PUSH_PASSWORD|COSIGN_PASSWORD|LM_COSIGN_PASSWORD)/);
      expect(s).not.toMatch(/-e (COSIGN_PASSWORD|LM_PUSH_PASSWORD)=|--password[ =]"?\$/);
    }
  });

  test('映像工具容器：非 root、唯讀根檔案系統、--cap-drop ALL、建置 label；可寫掛載只限映像工作目錄', () => {
    const runs = IMAGE_STAGES.flatMap((n) => dockerRunsIn(blocks[n]));
    // Trivy、Syft、crane（Image Push 的 shell 函式）、cosign（Image Sign 的 shell 函式）；Image Build 只呼叫 ci/scripts/。
    expect(runs.length).toBe(4);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.image=$LM_IMG_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).toMatch(/--network (none|bridge)\b/);
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) {
        if (!m[1].endsWith(',readonly')) expect(m[1]).toMatch(/^type=bind,src=\$LM_IMG_DIR\/(out|trivy-cache),dst=\/(out|cache)$/);
      }
    }
  });

  test('「映像」關卡：scan／prepush／final 三種條件、寫入 Build_Record，報告鍵通過白名單（Req 21.2、23.2、23.3、23.5）', () => {
    expect(gateFn).toContain("g.gate = '映像'");
    expect(gateFn).toContain("phase != 'scan' && facts.sbom != true");
    expect(gateFn).toContain("phase == 'final'");
    for (const s of ['signatureCovers(', 'recordImageFacts(', "rec.digest != digest || rec.commit != commit", "rec.sbom != 'reports/sbom.cdx.json'"]) expect(gateFn).toContain(s);
    expect(recordGate).toContain('bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_IMAGE_GATE_FILE"');
    expect(recordGate).toMatch(/gate\.pass == true && !recordPass\)\s*\{\s*return 0/);
    expect(functionBody('void imageStageFailed(String stage)')).toMatch(/LM_IMAGE_GATE_ELIGIBLE == 'true' && env\.LM_IMAGE_GATE_DONE != 'true'[\s\S]*recordImageGate\(phase, imgStageError\(stage\), true\)/);
    // 所有寫入 Build_Record 的報告鍵與 image 區段通過 ci/record.mjs 的白名單；main_push 的 trivy／sbom 有值。
    const paths = {};
    for (const text of [recordGate, ...IMAGE_STAGES.map((n) => blocks[n])]) {
      for (const m of text.matchAll(/(\w+): '(reports\/[^']+)'/g)) paths[m[1]] = m[2];
    }
    for (const k of ['trivy', 'sbom', 'imageBuildLog', 'imageContent', 'imageSmokeSummary', 'imageScanEvaluation', 'imageDigest', 'imageSignature']) expect(paths[k]).toBeDefined();
    const digest = `sha256:${'d'.repeat(64)}`;
    let rec = mergeRecord(base(), { reports: paths });
    rec = mergeRecord(rec, { image: { digest, tags: ['a'.repeat(40)] } });
    rec = mergeRecord(rec, { image: { signature: 'verified' } });
    expect(validateRecord(rec).ok).toBe(true);
    expect(rec.image).toEqual({ digest, tags: ['a'.repeat(40)], signature: 'verified' });
  });
});

describe('main 專用的 Staging Deploy 階段（Req 14.1–14.3、14.8、15.9、17.7、17.8、18.1–18.5、18.7–18.9、23.2）', () => {
  const stg = stageCode(STAGE.STAGING);
  const deploy = functionBody('void deployStaging()');
  const restore = functionBody('void restoreStaging()');
  const deployCmd = functionBody('int stagingDeployCommand()');
  const host = functionBody('int stagingHost(String action, String outName)');
  const prelude = functionBody('String stagingSshPrelude()');
  const verify = functionBody('int verifyStagingSignature()');
  const attest = functionBody('int attestStaging()');
  const smoke = functionBody('int runStagingSmoke()');
  const record = functionBody('int recordStagingGate(String stageError)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const staging = readFileSync(resolve(root, 'ci/staging.mjs'), 'utf8');

  test('緊接 Image Sign 之後、只在 main_push 的 Trusted 規劃中執行，且在「映像」關卡通過後才部署（Req 1.3、2.8、23.2）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(10, 12)).toEqual([STAGE.IMAGE_SIGN, STAGE.STAGING]);
    expect(stg).toContain(`when {\n        expression { planned('${STAGE.STAGING}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }`);
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    expect(TRUSTED_ONLY_STAGES).toContain(STAGE.STAGING);
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.indexOf(STAGE.STAGING)).toBe(main.indexOf(STAGE.IMAGE_SIGN) + 1);
    for (const t of [{ event: 'tag', ref: 'v1.2.3' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'push', ref: 'feature', manual: true }]) {
      expect(planStages(t).stages).not.toContain(STAGE.STAGING);
    }
    inOrder(stg, [
      'requireImageGatePassed()', "env.LM_STG_ELIGIBLE = 'true'", 'assertStagingConfig()', 'pullImages([env.LM_COSIGN_IMAGE])',
      'prepareStagingWork()', "lock(resource: 'lm-staging')", 'deployStaging()', 'restoreStaging()',
    ]);
    // 一般 lock 排隊等待，不以 skipIfLocked 略過（Req 18.9）。
    expect(stg).not.toContain('skipIfLocked');
    expect(stg).toMatch(/unsuccessful\s*\{\s*script\s*\{\s*stagingStageFailed\(\)/);
    expect(stg).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupStagingWork\(\)/);
    const req = functionBody('void requireImageGatePassed()');
    for (const s of ["reports/gate-image-final.json", "env.LM_IMAGE_GATE_DONE != 'true'", 'gatePassed(text, env.GIT_COMMIT_FULL', '/^sha256:[0-9a-f]{64}$/']) expect(req).toContain(s);
  });

  test('簽章驗證 → deploy → Smoke_Test → 判定 → 還原或 finalize → attestation →「Staging」關卡（Req 17.7、18.3–18.5）', () => {
    inOrder(deploy, [
      'verifyStagingSignature()', 'signatureCovers(sigText, digest)', "env.LM_STG_DEPLOY_CALLED = 'true'",
      "timeout(time: 75, unit: 'MINUTES')", 'stagingDeployCommand()', 'bun ci/staging.mjs classify --exit "$LM_STG_EXIT"',
      "c.outcome == 'refused'", 'runStagingSmoke()', 'bun ci/staging.mjs verdict', 'restoreStaging()',
      "env.LM_STG_VERIFIED = 'true'", "stagingHost('finalize', 'finalize.jsonl')", 'attestStaging()',
      'bun ci/staging.mjs check-attestation', "recordStagingGate('') != 0",
    ]);
    // 簽章未通過時不呼叫 Deploy_Host（Req 17.8）。
    expect(deploy.slice(0, deploy.indexOf('stagingDeployCommand()'))).toMatch(/if \(!sigOk\)\s*\{[\s\S]*?recordStagingGate\(''\)\s*error\(/);
    // 驗證未通過一律還原、記錄關卡並失敗，不寫 attestation。
    expect(deploy).toMatch(/if \(!verified\)\s*\{[\s\S]*?restoreStaging\(\)[\s\S]*?recordStagingGate\([\s\S]*?error\(/);
    expect(smoke).toContain("timeout(time: 10, unit: 'MINUTES')");
    expect(smoke).toContain('bun ci/smoke.mjs --provision > reports/staging/smoke.json');
    expect(smoke).toContain('credentialsId: env.LM_STAGING_SMOKE_CREDENTIALS, variable: \'LM_SMOKE_PASSWORD_FILE\'');
    expect(smoke).toContain('"LM_SMOKE_BASE_URL=${env.LM_STAGING_URL}"');
    expect(smoke).toContain("'LM_SMOKE_USERNAME=smoke-bot'");
    // ci/staging.mjs 的 Smoke_Test 步驟與 ci/smoke.mjs 相同（FEAT-001）。
    expect(staging).toContain("SMOKE_STEPS = Object.freeze(['index', 'robots', 'login', 'me', 'trips', 'realtime', 'logout'])");
    // 還原整體 5 分鐘：status → rollback（需要時）→ status → health --wait → restore 判讀（Req 18.5、18.8）。
    inOrder(restore, [
      "timeout(time: 5, unit: 'MINUTES')", "stagingHost('status', 'status-before-restore.json')", 'bun ci/staging.mjs rollback-needed',
      "stagingHost('rollback', 'rollback.jsonl')", "stagingHost('status', 'status-after-restore.json')", 'bun ci/staging.mjs active',
      "stagingHost('health', 'restore-health.jsonl')", 'bun ci/staging.mjs restore',
    ]);
    expect(restore).toContain("code: 'restore_unconfirmed'");
    // CLI 子命令與參數存在於 ci/staging.mjs。
    for (const s of ["case 'classify'", "case 'rollback-needed'", "case 'active'", "case 'restore'", "case 'verdict'", "case 'check-attestation'", "case 'record'"]) expect(staging).toContain(s);
    for (const s of ["o['smoke-exit']", "o['out-predicate']", "o['rollback-exit']", "o['health-exit']", "o['out-patch']", "o['out-gate']", "o['stage-error']"]) expect(staging).toContain(s);
  });

  test('SSH：Staging 專用金鑰（不同於 Production）、known_hosts 憑證、StrictHostKeyChecking、forced command 子命令（Req 15.9）', () => {
    expect(/LM_SSH_STAGING_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-ssh-staging');
    const rollbackJf = readFileSync(resolve(root, 'ci/jenkins/pipelines/rollback.Jenkinsfile'), 'utf8');
    expect(/LM_SSH_PROD_CREDENTIALS = '([^']+)'/.exec(rollbackJf)?.[1]).toBe('lm-ssh-prod');
    // Production Deploy 使用與 release/rollback 相同的 Production 金鑰；Staging 的函式從不引用它。
    expect(/LM_SSH_PROD_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-ssh-prod');
    expect(code.match(/lm-ssh-prod/g)?.length).toBe(1);
    for (const body of [deployCmd, host, stg, deploy, restore]) expect(body).not.toMatch(/LM_SSH_PROD_CREDENTIALS|lm-ssh-prod/);
    expect(/LM_KNOWN_HOSTS_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe(/LM_KNOWN_HOSTS_CREDENTIALS = '([^']+)'/.exec(rollbackJf)?.[1]);
    expect(prelude.split("'''")[1].trim().split('\n')[0].trim()).toBe('set +x');
    for (const flag of ['-F /dev/null', '-o BatchMode=yes', '-o IdentitiesOnly=yes', '-o IdentityAgent=none', '-o StrictHostKeyChecking=yes', '-o UserKnownHostsFile="$LM_KNOWN_HOSTS"', '-o GlobalKnownHostsFile=/dev/null']) {
      expect(prelude).toContain(flag);
    }
    for (const body of [deployCmd, host]) {
      expect(body).toContain('sshUserPrivateKey(credentialsId: env.LM_SSH_STAGING_CREDENTIALS');
      expect(body).toContain('file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS');
      expect(body).toContain('stagingSshPrelude()');
    }
    // forced command 綁定 `lm-deploy staging`：腳本只送出子命令，不含環境名稱。
    const cmds = [...(deployCmd + host).matchAll(/lm_ssh ([a-z-]+)/g)].map((m) => m[1]).sort();
    expect(cmds).toEqual(['deploy', 'finalize', 'health', 'rollback', 'status']);
    expect(deployCmd + host).not.toMatch(/lm_ssh [^>\n]*\b(prod|staging)\b/);
    expect(deployCmd).toContain('lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > reports/staging/deploy.jsonl');
    expect(host).toContain('lm_ssh health "$LM_STG_COLOR" --wait');
    // app.env（lm-staging-supabase-env）只以 `<` 重新導向成為 stdin（plan.md D6、D13）；細節見 Production 的測試。
    expect(deployCmd).toContain("withCredentials([file(credentialsId: env.LM_STAGING_STACK_ENV_CREDENTIALS, variable: 'LM_STACK_ENV_FILE')]) {");
    expect(code).not.toMatch(/echo[^\n]*\$(LM_REG_PASSWORD|LM_PUSH_PASSWORD)/);
  });

  test('部署前以 Credential_Store 的公鑰驗證簽章；attestation 以 digest、--tlog-upload=false 推送後再驗證（Req 17.7、18.4）', () => {
    expect(/LM_COSIGN_PUBLIC_KEY_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-cosign-pub');
    inOrder(verify, [
      'credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS',
      'set +x', 'DOCKER_CONFIG="$LM_STG_DIR/docker-verify"', '--password-stdin "$registry"',
      '"$LM_COSIGN_IMAGE" verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json', '"$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" > reports/staging/signature.json',
    ]);
    inOrder(attest, [
      'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS',
      'string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS',
      'cp reports/staging/predicate.json "$LM_STG_DIR/in/predicate.json"', 'ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"',
      'cosign attest --yes --key /keys/cosign.key --tlog-upload=false --type "$LM_STAGING_PREDICATE_TYPE"', '--predicate /in/predicate.json "$ref"',
      'unset COSIGN_PASSWORD', 'cosign verify-attestation --key /keys/cosign.pub --insecure-ignore-tlog=true --type "$LM_STAGING_PREDICATE_TYPE"',
    ]);
    expect(/LM_STAGING_PREDICATE_TYPE = '([^']+)'/.exec(source)?.[1]).toBe('https://little-moments.lan/attestations/staging-verified/v1');
    // 所有 cosign 容器：非 root、唯讀根檔案系統、--cap-drop ALL、建置 label；掛載一律唯讀。
    const runs = [...dockerRunsIn(verify), ...dockerRunsIn(attest)];
    expect(runs.length).toBe(2);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.staging=$LM_STG_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) expect(m[1].endsWith(',readonly')).toBe(true);
    }
    expect(functionBody('void cleanupStagingWork()')).toContain('"$WORKSPACE_TMP"/lm-staging-*) rm -rf -- "$LM_STG_DIR" ;;');
  });

  test('「Staging」關卡與 Build_Record：ci/staging.mjs record → record.mjs merge → gate；失敗時 post 記錄未通過（Req 14.8、23.3、23.5）', () => {
    inOrder(record, [
      'bun ci/staging.mjs record "$@"', 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/staging-record-patch.json',
      'bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-staging.json', "env.LM_STG_GATE_DONE = 'true'",
    ]);
    expect(record).toContain('--signature "$LM_STG_SIGNATURE" --finalize "$LM_STG_FINALIZE" --attestation "$LM_STG_ATTESTATION"');
    expect(functionBody('void stagingStageFailed()')).toMatch(/LM_STG_ELIGIBLE == 'true' && env\.LM_STG_GATE_DONE != 'true'[\s\S]*recordStagingGate\(stgStageError\(\)\)/);
    // Staging 的 Health_Check 每 10 秒一次（Req 18.3）：Deploy_Host 的 lm-deploy 依環境決定間隔。
    const lmDeploy = readFileSync(resolve(root, 'deploy/bin/lm-deploy'), 'utf8');
    expect(lmDeploy).toMatch(/if \[\[ \$ENVN == staging \]\]; then HEALTH_INTERVAL=10; else HEALTH_INTERVAL=5; fi/);
  });
});

describe('Security Scan 報告鏈：normalize → evaluate（以 Jenkinsfile 的檔名與參數執行）', () => {
  const commit = 'c'.repeat(40);
  const secret = 'AKIAZZZZZZZZZZZZZZZZ-not-a-real-secret-value';
  const raw = {
    'gitleaks-dir': [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Match: secret, Secret: secret, Line: `const k = '${secret}'` }],
    'gitleaks-git': [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Commit: 'd'.repeat(40), Match: secret, Secret: secret }],
    osv: { results: [{ source: { path: '/src/bun.lock', type: 'lockfile' }, packages: [{ package: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm' }, groups: [], vulnerabilities: [] }] }] },
    'osv-cargo': { results: [{ source: { path: '/src/Cargo.lock', type: 'lockfile' }, packages: [{ package: { name: 'serde', version: '1.0.228', ecosystem: 'crates.io' }, groups: [], vulnerabilities: [] }] }] },
    'trivy-node-modules': { Trivy: { Version: '0.0.0' }, Results: [{ Target: 'node_modules', Packages: [{ Name: 'left-pad', Version: '1.3.0' }] }] },
    semgrep: { version: '1.0.0', errors: [], paths: { scanned: ['server/http.js'] }, results: [] },
  };
  const tools = { 'gitleaks-dir': 'gitleaks', 'gitleaks-git': 'gitleaks', osv: 'osv-scanner', 'osv-cargo': 'osv-scanner', 'trivy-node-modules': 'trivy', semgrep: 'semgrep' };

  // 與 Jenkinsfile 的 normalize 迴圈及 evaluate --reports 同一順序。
  test('報告名稱與 Jenkinsfile 一致', () => {
    const specs = /for spec in ([^;]+);/.exec(stageCode('Security Scan'))?.[1].trim().split(/\s+/) ?? [];
    expect(specs.map((s) => s.split(':').reverse())).toEqual(Object.entries(tools));
  });

  async function runChain(names, today = '2025-01-01') {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { main: normalize } = await import('../ci/policy/normalize.mjs');
    const { main: evaluate } = await import('../ci/policy/evaluate.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'lm-sec-'));
    const quiet = { log: () => {}, error: () => {} };
    try {
      for (const name of Object.keys(tools)) {
        if (names.includes(name)) writeFileSync(join(dir, `${name}.raw.json`), JSON.stringify(raw[name]));
        normalize(['--tool', tools[name], '--in', join(dir, `${name}.raw.json`), '--out', join(dir, `${name}.json`)], quiet);
      }
      const out = join(dir, 'evaluation.json');
      const rc = evaluate([
        '--reports', ...Object.keys(tools).map((n) => join(dir, `${n}.json`)),
        '--exceptions', resolve(root, 'security/exceptions.json'), '--commit', commit, '--today', today, '--out', out,
      ], quiet);
      const files = Object.keys(tools).map((n) => join(dir, `${n}.json`)).concat(out);
      const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
      return { rc, evaluation: JSON.parse(readFileSync(out, 'utf8')), text };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('偵測到秘密時不通過，且正規化與評估報告不含秘密原文（Req 6.4、6.7）', async () => {
    const { rc, evaluation, text } = await runChain(Object.keys(tools));
    expect(rc).toBe(1);
    expect(evaluation.pass).toBe(false);
    expect(evaluation.commit).toBe(commit);
    expect(evaluation.unresolved.map((f) => [f.scanner, f.id, f.location, f.line, f.reason])).toEqual([
      ['gitleaks', 'aws-access-token', 'server/config.js', 3, 'secret'],
      ['gitleaks', 'aws-access-token', 'server/config.js', 3, 'secret'],
    ]);
    expect(evaluation.unresolved[1].commit).toBe('d'.repeat(40));
    expect(text).not.toContain('AKIAZZZZ');
    expect(text).not.toContain('not-a-real-secret');
  });

  test('任一掃描報告缺失（例如 Git 歷史範圍無法決定）時視為未完成而不通過（Req 6.8）', async () => {
    raw['gitleaks-dir'] = [];
    try {
      const { rc, evaluation } = await runChain(['gitleaks-dir', 'osv', 'osv-cargo', 'trivy-node-modules', 'semgrep']);
      expect(rc).toBe(1);
      expect(evaluation.pass).toBe(false);
      expect(evaluation.unresolved).toEqual([]);
      expect(evaluation.incomplete.map((i) => i.scanner)).toEqual(['gitleaks']);
      expect(evaluation.incomplete[0].file).toMatch(/gitleaks-git\.json$/);
    } finally {
      raw['gitleaks-dir'] = [{ RuleID: 'aws-access-token', File: 'server/config.js', StartLine: 3, Match: secret, Secret: secret }];
    }
  });

  test('所有掃描完成且無 Critical/High 結果時通過', async () => {
    const clean = { ...raw };
    raw['gitleaks-dir'] = [];
    raw['gitleaks-git'] = [];
    try {
      const { rc, evaluation } = await runChain(Object.keys(tools));
      expect(rc).toBe(0);
      expect(evaluation.pass).toBe(true);
      expect(evaluation.scans.map((s) => s.complete)).toEqual([true, true, true, true, true, true]);
    } finally {
      Object.assign(raw, clean);
    }
  });

  // osv-scanner 2.7.1 對 Cargo.lock 的報告形狀（沒有嚴重度分數的 RUSTSEC advisory 視為 high）。
  const cargoReport = (packages) => ({
    results: [{ source: { path: '/src/Cargo.lock', type: 'lockfile' }, packages: packages.map(([name, version, ids]) => ({
      package: { name, version, ecosystem: 'crates.io' },
      groups: ids.map((id) => ({ ids: [id], aliases: [id], max_severity: '' })),
      vulnerabilities: ids.map((id) => ({ id, summary: `${name} advisory`, affected: [] })),
    })) }],
  });

  test('Cargo.lock：只有 paste 1.0.15 的 RUSTSEC-2024-0436 以 security/exceptions.json 的例外處理；其他沒有分數的 advisory 阻擋', async () => {
    const clean = { ...raw };
    raw['gitleaks-dir'] = [];
    raw['gitleaks-git'] = [];
    try {
      raw['osv-cargo'] = cargoReport([['paste', '1.0.15', ['RUSTSEC-2024-0436']], ['rsa', '0.9.10', []]]);
      const ok = await runChain(Object.keys(tools), '2026-11-25');
      expect(ok.rc).toBe(0);
      expect(ok.evaluation.pass).toBe(true);
      const applied = ok.evaluation.findings.filter((f) => f.exception?.status === 'applied');
      expect(applied.map((f) => [f.scanner, f.id, f.location, f.version, f.exception.approver])).toEqual([
        ['osv-scanner', 'RUSTSEC-2024-0436', 'paste', '1.0.15', 'Raigorlin'],
      ]);

      raw['osv-cargo'] = cargoReport([['paste', '1.0.15', ['RUSTSEC-2024-0436']], ['url', '2.5.8', ['RUSTSEC-2026-0592']], ['chrono', '0.4.45', ['RUSTSEC-2026-0543']]]);
      const blocked = await runChain(Object.keys(tools), '2026-11-25');
      expect(blocked.rc).toBe(1);
      expect(blocked.evaluation.unresolved.map((f) => [f.id, f.location, f.reason])).toEqual([
        ['RUSTSEC-2026-0592', 'url', 'no-exception'],
        ['RUSTSEC-2026-0543', 'chrono', 'no-exception'],
      ]);

      // 例外到期後（2027-03-01）paste 重新阻擋
      raw['osv-cargo'] = cargoReport([['paste', '1.0.15', ['RUSTSEC-2024-0436']]]);
      const expired = await runChain(Object.keys(tools), '2027-03-01');
      expect(expired.rc).toBe(1);
      expect(expired.evaluation.unresolved.map((f) => [f.id, f.reason])).toEqual([['RUSTSEC-2024-0436', 'exception-expired']]);

      // Cargo.lock 解析出 0 個套件 → 掃描未完成
      raw['osv-cargo'] = { results: [] };
      const empty = await runChain(Object.keys(tools), '2026-11-25');
      expect(empty.rc).toBe(1);
      expect(empty.evaluation.incomplete.map((i) => i.file)).toEqual([expect.stringMatching(/osv-cargo\.json$/)]);
    } finally {
      Object.assign(raw, clean);
    }
  });
});

describe('verify-toolchain --record-patch（Req 3.3）', () => {
  const base = () => createRecord({
    job: 'release/little-moments/main', number: 1, url: 'https://jenkins.invalid/job/1/',
    commit: 'a'.repeat(40), trigger: 'main_push', ref: 'main', buildImageDigest: `sha256:${'b'.repeat(64)}`,
  });

  test('實際版本寫入 toolchain 區段，報告路徑寫入 reports.toolchain，且通過 Build_Record 白名單', () => {
    const rec = toolchainRecord({ bun: '1.3.0', node: '22.20.0', chromium: '141.0.7390.37' }, { bun: '1.3.0', node: '22.19.0', chromium: null });
    const patch = recordPatch(rec, 'reports/toolchain.json');
    expect(patch).toEqual({ toolchain: { bun: '1.3.0', node: '22.19.0', chromium: null }, reports: { toolchain: 'reports/toolchain.json' } });
    const merged = mergeRecord(base(), patch);
    expect(validateRecord(merged).ok).toBe(true);
    expect(merged.toolchain).toEqual({ buildImageDigest: `sha256:${'b'.repeat(64)}`, bun: '1.3.0', node: '22.19.0', chromium: null });
  });

  test('沒有報告路徑時只輸出 toolchain 區段', () => {
    expect(recordPatch(toolchainRecord({}, {}), null)).toEqual({ toolchain: { bun: null, node: null, chromium: null } });
  });
});

describe('main 的 Production Deploy 與 Version Tag（plan.md D1、D2、D10；Req 14.1–14.3、16.10、20、22.5、23）', () => {
  const RELEASE_STAGES = [STAGE.PRODUCTION, STAGE.VERSION_TAG];
  const blocks = Object.fromEntries(RELEASE_STAGES.map((n) => [n, stageCode(n)]));
  const init = stageCode(STAGE.INIT);
  const registryFn = functionBody('int releaseRegistry(String action)');
  const versionFn = functionBody('void applyVersionTag()');
  const pushTag = functionBody('int pushVersionTag()');
  const deploy = functionBody('void deployProduction()');
  const observe = functionBody('boolean observeProduction(String color)');
  const observeStepFn = functionBody('int observeStep(String type, int exitCode, String result, long ms, String phase)');
  const restore = functionBody('void restoreProduction()');
  const deployCmd = functionBody('int productionDeployCommand()');
  const stgDeployCmd = functionBody('int stagingDeployCommand()');
  const host = functionBody('int prodHost(String action, String outName)');
  const smoke = functionBody('int runProductionSmoke(String outName)');
  const recordPrd = functionBody('int recordProductionGate(String stageError)');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { const idx = list.map((s) => at(text, s)); expect(idx).toEqual([...idx].sort((a, b) => a - b)); };
  const production = readFileSync(resolve(root, 'ci/production.mjs'), 'utf8');
  const resolveDigest = readFileSync(resolve(root, 'ci/resolve-digest.mjs'), 'utf8');

  test('緊接 Staging Deploy 之後依序為 Production Deploy → Version Tag，只在 main_push 的 Trusted 規劃中執行（plan.md D1）', async () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names.slice(11)).toEqual([STAGE.STAGING, ...RELEASE_STAGES]);
    for (const n of RELEASE_STAGES) {
      expect(blocks[n]).toContain(`when {\n        expression { planned('${n}') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }`);
      expect(blocks[n]).toMatch(/cleanup\s*\{\s*script\s*\{\s*cleanupReleaseWork\(\)/);
    }
    expect(code).not.toContain("env.LM_TRIGGER_KIND == 'release_tag'");
    const { TRUSTED_ONLY_STAGES, planStages } = await import('../ci/stages.mjs');
    for (const n of RELEASE_STAGES) expect(TRUSTED_ONLY_STAGES).toContain(n);
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.slice(main.indexOf(STAGE.STAGING), main.indexOf(STAGE.VERSION_TAG) + 1)).toEqual([STAGE.STAGING, ...RELEASE_STAGES]);
    for (const t of [{ event: 'push', ref: 'rust' }, { event: 'pull_request', ref: 'x', isPullRequest: true, manual: true }, { event: 'tag', ref: 'v2.0.0' }]) {
      for (const n of RELEASE_STAGES) expect(planStages(t).stages).not.toContain(n);
    }
    // 前一個關卡已記錄且通過才執行（Req 23.2）：Production 需要「Staging」，Version Tag 需要「上線後」。
    inOrder(blocks[STAGE.PRODUCTION], ['requireStagingPassed()', "env.LM_PRD_ELIGIBLE = 'true'", 'assertProductionConfig()', 'pullImages([env.LM_COSIGN_IMAGE])', "lock(resource: 'lm-prod', skipIfLocked: true)", 'deployProduction()', 'restoreProduction()']);
    inOrder(blocks[STAGE.VERSION_TAG], ['requirePostDeployPassed()', 'assertProductionConfig()', 'pullImages([env.LM_CRANE_IMAGE])', 'prepareReleaseWork()', 'applyVersionTag()']);
    expect(blocks[STAGE.PRODUCTION]).toMatch(/unsuccessful\s*\{\s*script\s*\{\s*productionStageFailed\(\)/);
    for (const [f, list] of [
      ['void requireStagingPassed()', ['reports/gate-staging.json', "env.LM_STG_GATE_DONE != 'true'", "env.LM_STG_VERIFIED != 'true'", 'gatePassed(text, env.GIT_COMMIT_FULL']],
      ['void requirePostDeployPassed()', ['reports/gate-post-deploy.json', "env.LM_PRD_OBSERVED != 'true'", "env.LM_PRD_GATE_DONE != 'true'", 'gatePassed(text, env.GIT_COMMIT_FULL', "isReleaseTag(env.LM_RELEASE_VERSION ?: '')"]],
    ]) {
      for (const s of list) expect(functionBody(f)).toContain(s);
    }
  });

  test('沒有任何人工核准：無 input 步驟、無核准迴圈、無 Release_Tag 的 Tag 驗證或 digest 解析（plan.md D1）', () => {
    expect(code).not.toMatch(/\binput\s*\(/);
    for (const gone of ['releaseApprovalLoop', 'waitForApproval', 'requireApprovalPassed', 'verifyTagUnchanged', 'resolveReleaseImage', 'fetchMainRecord',
      'ci/approval.mjs', 'ci/policy/tag.mjs', 'step lookup', 'step image', 'step staging', 'TAG_NAME"', 'LM_JENKINS_API_CREDENTIALS']) {
      expect({ gone, found: code.includes(gone) }).toEqual({ gone, found: false });
    }
  });

  test('Init：main_push 由 Cargo.toml 取得發布版本 v<版本>（ci/release-version.mjs），格式無效即失敗（plan.md D2）', () => {
    inOrder(init, [
      'bun ci/record.mjs init', 'if (planRc != 0 || plan.reject || !plan.kind)', "if (env.LM_TRIGGER_KIND == 'main_push')",
      "'bun ci/release-version.mjs > reports/release-version.txt'", 'if (!isReleaseTag(version))', 'env.LM_RELEASE_VERSION = version',
    ]);
    expect(readFileSync(resolve(root, 'ci/release-version.mjs'), 'utf8')).toContain('[workspace.package]');
  });

  test('Production Deploy：狀態 → 首次部署保護 → 簽章 → deploy → 觀察期 → 回滾或 finalize →「上線後」（Req 17.8、20.1–20.7、20.12；plan.md D10）', () => {
    expect(blocks[STAGE.PRODUCTION]).toMatch(/if \(!acquired\)\s*\{\s*recordProductionGate\([^\n]*\)\s*error\('已有部署進行中/);
    inOrder(deploy, [
      "prodHost('status', 'status-locked.json')", 'bun ci/production.mjs active --status reports/production/status-locked.json',
      "recordProductionGate('Production 尚未完成首次部署，請依 deploy/README.md 的首次切換步驟完成 bootstrap')",
      "releaseRegistry('verify-prod')", 'signatureCovers(sigText, digest)', "env.LM_PRD_DEPLOY_CALLED = 'true'",
      "timeout(time: 75, unit: 'MINUTES')", 'productionDeployCommand()', 'bun ci/production.mjs classify --exit "$LM_PRD_EXIT"',
      "c.outcome == 'refused'", 'restoreProduction()', "timeout(time: 15, unit: 'MINUTES')", 'observeProduction(color)',
      "prdStep('「上線後」關卡未通過；已自動回滾", "env.LM_PRD_OBSERVED = 'true'", "prodHost('finalize', 'finalize.jsonl')", "recordProductionGate('') != 0",
    ]);
    // 沒有作用中的版本時記錄「上線後」未通過並停止，不呼叫 deploy（plan.md D10）。
    const guard = deploy.slice(0, deploy.indexOf("releaseRegistry('verify-prod')"));
    expect(guard).toMatch(/if \(activeRc != 0 \|\| !\(base ==~ \/\^sha256:\[0-9a-f\]\{64\}\$\/\)\) \{[\s\S]*?recordProductionGate\([\s\S]*?error\('Production 尚未完成首次部署/);
    expect(guard).not.toContain('productionDeployCommand()');
    expect(guard).toMatch(/if \(stRc != 0\) \{[\s\S]*?recordProductionGate\([\s\S]*?error\(/);
    // 簽章未通過時不呼叫 Deploy_Host 的 deploy（Req 17.8）。
    expect(deploy.slice(0, deploy.indexOf('productionDeployCommand()'))).toMatch(/if \(!sigOk\)\s*\{[\s\S]*?recordProductionGate\([\s\S]*?error\(/);
    // 觀察期：每 10 秒一次 Health_Check（共 60 次）、切換後與結束前各一次 Smoke_Test、10 分鐘（Req 20.5）。
    inOrder(observe, [
      'for (int i = 0; i < 60; i++)', 'long wait = t0 + i * 10000L - System.currentTimeMillis()', "prodHost('health-once', 'health-last.jsonl')",
      "observeStep('health'", 'if (i == 0 || i == 54)', 'runProductionSmoke(', "observeStep('smoke'", 't0 + 600000L', 'bun ci/production.mjs summary',
    ]);
    expect(observe.match(/return false/g)?.length).toBe(2);
    expect(observeStepFn).toContain('bun ci/production.mjs observe "$@"');
    expect(observeStepFn).toContain('--t "$(( LM_PRD_OBS_MS / 1000 ))"');
    inOrder(restore, [
      "timeout(time: 5, unit: 'MINUTES')", "prodHost('status', 'status-before-restore.json')", 'bun ci/production.mjs rollback-needed',
      "prodHost('rollback', 'rollback.jsonl')", "prodHost('status', 'status-after-restore.json')", 'bun ci/production.mjs active',
      "prodHost('health-wait', 'restore-health.jsonl')", 'bun ci/production.mjs restore',
    ]);
    expect(restore).toContain("code: 'restore_unconfirmed'");
    // Production 的 Smoke_Test 不註冊帳號（smoke-bot 於首次切換時建立）；Staging 以 --provision 執行（plan.md D9）。
    expect(smoke).toContain("timeout(time: 90, unit: 'SECONDS')");
    expect(smoke).toContain("credentialsId: env.LM_PROD_SMOKE_CREDENTIALS, variable: 'LM_SMOKE_PASSWORD_FILE'");
    expect(smoke).toContain('"LM_SMOKE_BASE_URL=${env.LM_PROD_URL}"');
    expect(smoke).toContain('bun ci/smoke.mjs > "$LM_PRD_SMOKE_OUT"');
    expect(smoke).not.toContain('--provision');
    expect(functionBody('int runStagingSmoke()')).toContain('bun ci/smoke.mjs --provision > reports/staging/smoke.json');
    expect(code).not.toContain('scripts/smoke.mjs');
    inOrder(recordPrd, [
      'bun ci/production.mjs record "$@"', 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/production-record-patch.json',
      'bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-post-deploy.json', "env.LM_PRD_GATE_DONE = 'true'",
      "fileExists('reports/production/rollback-summary.txt')", 'appendSummary(',
    ]);
    expect(recordPrd).toContain('--tag "${LM_RELEASE_VERSION:-}"');
    expect(recordPrd).toContain('--signature "$LM_PRD_SIGNATURE" --finalize "$LM_PRD_FINALIZE"');
    expect(functionBody('void productionStageFailed()')).toMatch(/LM_PRD_ELIGIBLE == 'true' && env\.LM_PRD_GATE_DONE != 'true'[\s\S]*recordProductionGate\(prdStageError\(\)\)/);
    expect(blocks[STAGE.PRODUCTION]).toMatch(/catch \(err\)\s*\{[\s\S]*?LM_PRD_DEPLOY_CALLED == 'true' && env\.LM_PRD_OBSERVED != 'true' && env\.LM_PRD_RESTORE_DONE != 'true'[\s\S]*?restoreProduction\(\)[\s\S]*?throw err/);
  });

  test('Production SSH 與 Supabase 金鑰檔：lm-ssh-prod、known_hosts、forced command 子命令；金鑰檔只以 `<` 交給 lm-deploy（Req 15.1、15.2、15.9）', () => {
    for (const [name, id] of [['LM_PROD_STACK_ENV_CREDENTIALS', 'lm-prod-supabase-env'], ['LM_STAGING_STACK_ENV_CREDENTIALS', 'lm-staging-supabase-env'], ['LM_PROD_SMOKE_CREDENTIALS', 'lm-prod-smoke']]) {
      expect(new RegExp(`${name} = '([^']+)'`).exec(source)?.[1]).toBe(id);
    }
    for (const body of [deployCmd, host]) {
      expect(body).toContain('sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS');
      expect(body).toContain('file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS');
      expect(body).toContain('productionSshPrelude()');
      expect(body).not.toContain('LM_SSH_STAGING_CREDENTIALS');
    }
    expect(functionBody('String productionSshPrelude()')).toContain('return stagingSshPrelude()');
    const cmds = [...(deployCmd + host).matchAll(/lm_ssh ([a-z-]+)/g)].map((m) => m[1]).sort();
    expect(cmds).toEqual(['deploy', 'finalize', 'health', 'health', 'rollback', 'status']);
    expect(deployCmd + host).not.toMatch(/lm_ssh [^>\n]*\b(prod|staging)\b/);
    // 兩個環境的 deploy：Secret file 只在 deploy 的 withCredentials 內，只以 -s 檢查與 `<` 重新導向使用。
    for (const [body, env, out] of [[deployCmd, 'LM_PROD_STACK_ENV_CREDENTIALS', 'reports/production/deploy.jsonl'], [stgDeployCmd, 'LM_STAGING_STACK_ENV_CREDENTIALS', 'reports/staging/deploy.jsonl']]) {
      expect(body).toContain(`withCredentials([file(credentialsId: env.${env}, variable: 'LM_STACK_ENV_FILE')]) {`);
      expect(body).toContain(`lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > ${out}`);
      expect(body).toMatch(/if \[ ! -s "\$LM_STACK_ENV_FILE" \]; then\n\s*echo '[^'$]*' >&2\n\s*exit 2\n/);
      expect(body).not.toMatch(/printf|readFile|returnStdout|\bcat\b|set -x/);
    }
    const uses = [...code.matchAll(/^.*LM_STACK_ENV_FILE.*$/gm)].map((m) => m[0].trim());
    expect(uses.sort()).toEqual([
      ...Array(2).fill('if [ ! -s "$LM_STACK_ENV_FILE" ]; then'),
      'lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > reports/production/deploy.jsonl',
      'lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > reports/staging/deploy.jsonl',
      "withCredentials([file(credentialsId: env.LM_PROD_STACK_ENV_CREDENTIALS, variable: 'LM_STACK_ENV_FILE')]) {",
      "withCredentials([file(credentialsId: env.LM_STAGING_STACK_ENV_CREDENTIALS, variable: 'LM_STACK_ENV_FILE')]) {",
    ].sort());
    const uses2 = (re) => [...code.matchAll(re)].map((m) => m.index);
    const inside = (i, block) => { const s = code.indexOf(block); return i > s && i < s + block.length; };
    for (const [re, body] of [[/credentialsId: env\.LM_PROD_STACK_ENV_CREDENTIALS/g, deployCmd], [/credentialsId: env\.LM_STAGING_STACK_ENV_CREDENTIALS/g, stgDeployCmd]]) {
      const found = uses2(re);
      expect(found.length).toBe(1);
      expect(inside(found[0], body)).toBe(true);
    }
    for (const i of uses2(/credentialsId: env\.LM_SSH_PROD_CREDENTIALS/g)) expect(inside(i, deployCmd) || inside(i, host)).toBe(true);
    // Bun 版的 Database 帳號、Setup_Token 與收據 AI 已移除（plan.md D13、D14）。
    expect(code).not.toMatch(/CAMPING_|LM_RECEIPT_AI|OPENAI|_DB_CREDENTIALS|SETUP_TOKEN|LM_STAGING_DB_NAME|LM_PROD_DB_NAME/i);
    const lmDeploy = readFileSync(resolve(root, 'deploy/bin/lm-deploy'), 'utf8');
    expect(lmDeploy).toContain('\\"healthy\\":true,\\"at\\":$(jstr "$at"),\\"durationMs\\":$H_MS}');
  });

  test('Version Tag：v<版本> 不覆寫既有標籤；推送帳號只在 pushVersionTag 內（Req 16.6、16.10；plan.md D2）', () => {
    inOrder(versionFn, [
      "String tag = env.LM_RELEASE_VERSION ?: ''", 'isReleaseTag(tag)', "releaseRegistry('tag-get')",
      'bun ci/resolve-digest.mjs step version-tag --digest "$LM_IMAGE_DIGEST"', 'if (rc == 4)',
      "d.decision == 'create'", 'pushVersionTag()', 'bun ci/resolve-digest.mjs step version-tag-verify', "d.decision != 'noop'",
      'image: [tags: [env.GIT_COMMIT_FULL, tag]]',
    ]);
    expect(versionFn).toMatch(/if \(rc == 4\)\s*\{\s*appendSummary\([\s\S]*?error\(/);
    inOrder(pushTag, [
      'credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS', 'set +x', 'DOCKER_CONFIG="$LM_REL_DIR/docker-push"', 'trap ',
      'crane tag "$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" "$LM_RELEASE_VERSION"', 'crane digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION"',
    ]);
    // Registry 唯讀操作只剩版本標籤查詢與 Production 部署前的簽章驗證。
    expect(registryFn).toContain("if (!(action in ['tag-get', 'verify-prod']))");
    inOrder(registryFn, [
      'credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS', 'file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS', 'set +x',
      'DOCKER_CONFIG="$LM_REL_DIR/docker-pull"', '--password-stdin "$registry"',
      'digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION"', 'verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json "$ref"',
    ]);
    const runs = [...dockerRunsIn(registryFn), ...dockerRunsIn(pushTag)];
    expect(runs.length).toBe(2);
    for (const cmd of runs) {
      for (const flag of ['--rm', '--user "$(id -u):$(id -g)"', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--label "lm.ci.build=$BUILD_TAG"', '--label "lm.ci.release=$LM_REL_RUN"']) {
        expect(cmd).toContain(flag);
      }
      expect(cmd).not.toMatch(/--privileged|docker\.sock/);
      for (const m of cmd.matchAll(/--mount "([^"]+)"/g)) expect(m[1].endsWith(',readonly')).toBe(true);
    }
    for (const s of ["case 'version-tag'", "case 'version-tag-verify'"]) expect(resolveDigest).toContain(s);
  });

  test('Jenkinsfile 呼叫的 ci/production.mjs 子命令皆存在', () => {
    const used = [...new Set([...code.matchAll(/bun ci\/production\.mjs ([a-z-]+)/g)].map((m) => m[1]))].sort();
    expect(used).toEqual(['active', 'classify', 'observe', 'record', 'restore', 'rollback-needed', 'summary']);
    for (const s of used) expect(production).toContain(`case '${s}'`);
  });
});

describe('收尾 post { always } 與 post { cleanup }（13.8；Req 2.6、15.4、21.2、21.6、21.9、21.11、22.2–22.4、22.7、22.8、23.1）', () => {
  // 管線層級的 post（兩個空白縮排）位於 stages 之後、輔助函式之前；Components 第 22.1 節起 always／cleanup
  // 只呼叫 pipelinePostAlways()／pipelinePostCleanup()，收尾步驟在這兩個頂層函式內。
  const postStart = code.indexOf('\n  post {\n    always {');
  const helpers = code.indexOf('\nvoid enterStage(String name)');
  const post = code.slice(postStart, code.indexOf('\n}\n', postStart) + 3);
  const always = functionBody('void pipelinePostAlways()');
  const cleanup = functionBody('void pipelinePostCleanup()');
  const at = (text, s) => { const i = text.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
  const inOrder = (text, list) => { let prev = -1; for (const s of list) { const i = text.indexOf(s, prev + 1); expect(i).toBeGreaterThan(prev); prev = i; } };
  const archive = functionBody('void archiveScrubbedReports(Map outcome)');
  const scrubRun = functionBody('int scrubReports()');
  const specs = functionBody('List scrubCredentialSpecs()');
  const stageSecret = functionBody('void stageScrubSecret(Map s)');
  const keep = functionBody('void keepProductionBuildLog()');
  const resources = functionBody('void cleanupBuildResources()');
  const notify = functionBody('void notifyFinal()');
  const outcome = functionBody('Map finalOutcome(String result, String currentStage, String postFailure)');

  test('管線層級 post 位於 stages 之後；always 依序 finalize → 遮罩封存 → keepLog → 清除資源 → 通知；cleanup 最後 cleanWs()', () => {
    expect(postStart).toBeGreaterThan(code.indexOf("stage('Version Tag')"));
    expect(helpers).toBeGreaterThan(postStart);
    expect(post).toMatch(/^\n  post \{\n    always \{\n      script \{ pipelinePostAlways\(\) \}\n    \}\n    cleanup \{\n      script \{ pipelinePostCleanup\(\) \}\n    \}\n  \}\n\}\n$/);
    expect(code.indexOf('\nvoid pipelinePostAlways()')).toBeLessThan(helpers);
    inOrder(always, [
      "postStep('Post Finalize') { finalizeBuildRecord(outcome) }",
      "postStep('Post Archive') { archiveScrubbedReports(outcome) }",
      "postStep('Post Keep Log') { keepProductionBuildLog() }",
      "postStep('Post Cleanup') { cleanupBuildResources() }",
      'notifyFinal()',
    ]);
    // 結果在任何收尾步驟之前取得，第一個失敗階段取自 enterStage 記錄的 LM_CURRENT_STAGE。
    expect(at(always, 'env.LM_POST_RESULT_BEFORE = currentBuild.currentResult')).toBeLessThan(at(always, 'postStep('));
    expect(always).toContain("finalOutcome(currentBuild.currentResult, env.LM_CURRENT_STAGE ?: '', '')");
    inOrder(cleanup, ["postStep('Post Cleanup') { removePostWork() }", 'cleanWs(deleteDirs: true, disableDeferredWipeout: true)', 'dir(env.WORKSPACE_TMP) { deleteDir() }']);
    expect(always).not.toContain('cleanWs(');
  });

  test('每個收尾步驟以 catchError 隔離：失敗只讓結果變差、不略過後續步驟，並記錄第一個失敗的收尾步驟', () => {
    const step = functionBody('void postStep(String step, Closure body)');
    expect(step).toContain("catchError(buildResult: 'FAILURE'");
    // catchError 的 buildResult 只會讓結果變差（不覆蓋 FAILURE／ABORTED）；不設定 stageResult（post 不在任何 stage 內）。
    expect(step).not.toContain('stageResult');
    expect(step).toMatch(/catch \(err\) \{\s*if \(!env\.LM_POST_FAILED_STEP\) \{ env\.LM_POST_FAILED_STEP = step \}\s*throw err/);
    for (const s of ['Post Finalize', 'Post Archive', 'Post Keep Log', 'Post Cleanup']) expect(always).toContain(`postStep('${s}')`);
    expect(cleanup.match(/catchError\(buildResult: 'FAILURE'/g)?.length).toBe(2);
  });

  test('Build_Record finalize：結果、結束時間與第一個失敗階段（Req 21.2、21.11）', () => {
    const fin = functionBody('void finalizeBuildRecord(Map outcome)');
    inOrder(fin, ['fileExists(env.LM_RECORD)', 'LM_POST_STATUS=${outcome.record}', 'LM_POST_FAILED_STAGE=${outcome.failedStage', 'inBuildImage {', 'bun ci/record.mjs finalize "$@"']);
    expect(fin).toContain('set -- --record "$LM_RECORD" --status "$LM_POST_STATUS"');
    expect(fin).toContain('--first-failed-stage "${LM_POST_FAILED_STAGE:-}"');
    // 結果對應：SUCCESS／FAILURE／ABORTED（ci/record.mjs 的 RESULT_STATUSES）與通知的最終狀態。
    expect(outcome).toContain("r == 'SUCCESS' ? 'SUCCESS' : ((r == 'ABORTED' || r == 'NOT_BUILT') ? 'ABORTED' : 'FAILURE')");
    for (const s of ["'success'", "'unstable'", "'aborted'", "'failure'"]) expect(outcome).toContain(s);
    expect(outcome).toMatch(/if \(record != 'SUCCESS'\) \{\s*stage = postFailure \?: \(currentStage \?: 'Init'\)/);
    // record.mjs 的 finalize 寫入含時區的結束時間。
    const record = readFileSync(resolve(root, 'ci/record.mjs'), 'utf8');
    expect(record).toContain("status: o.status, firstFailedStage: o['first-failed-stage'], endedAt: new Date().toISOString()");
  });

  test('封存前遮罩：重新取得秘密 → ci/scrub.mjs → 只封存遮罩後副本；秘密集合不完整或無法完成時不封存（Req 15.4、21.9、23.1）', () => {
    expect(code).not.toContain('LM_SCRUB_INCOMPLETE');
    inOrder(archive, [
      'stageScrubSecrets()',
      'int rc = scrubReports()',
      'markRecordArchiveFailure()',
      'if (rc != 0 && rc != 1)',
      'dir("${env.WORKSPACE_TMP}/lm-post/archive")',
      'archiveArtifacts(',
      "env.LM_POST_ARCHIVED = 'true'",
      'if (rc == 1)',
      'finally {',
      'removeScrubSecrets()',
    ]);
    // 任何 archiveArtifacts 都在 scrub 之後、且只在遮罩輸出目錄內。
    const scrubAt = at(archive, 'scrubReports()');
    for (const m of archive.matchAll(/archiveArtifacts\(/g)) expect(m.index).toBeGreaterThan(scrubAt);
    expect(archive).toContain("archiveArtifacts(artifacts: 'reports/**', excludes: 'reports/image-digest.txt, reports/build-record.json', allowEmptyArchive: true)");
    expect(archive).toContain("archiveArtifacts(artifacts: 'reports/build-record.json', fingerprint: true)");
    // 無法取得秘密、Build_Image 無法使用或 scrub 無法完成：寫入摘要並 error()，在 archiveArtifacts 之前。
    for (const s of ['if (!missing.isEmpty())', 'if (!env.BUILD_IMAGE_DIGEST)', 'if (rc != 0 && rc != 1)']) {
      const i = at(archive, s);
      expect(archive.indexOf('error(', i)).toBeLessThan(at(archive, 'archiveArtifacts('));
    }
    // scrub：secrets 只以目錄路徑傳遞；輸入為 reports/，輸出與處理報告在 $WORKSPACE_TMP；無法完成時刪除輸出。
    expect(scrubRun).toContain('bun ci/scrub.mjs --secrets-dir "$WORKSPACE_TMP/lm-scrub-secrets" --in reports --out "$out/reports"');
    expect(scrubRun).toContain('--report "$out/reports/archive-scrub.json"');
    expect(scrubRun).toMatch(/if \[ "\$rc" -ne 0 \] && \[ "\$rc" -ne 1 \]; then\s*rm -rf "\$out"/);
    expect(scrubRun).toContain("timeout(time: 10, unit: 'MINUTES')");
    // 遮罩後仍有檔案被扣留且原本成功：Build_Record 改記錄為失敗後重新遮罩，使封存的紀錄與最終結果一致。
    expect(functionBody('void markRecordArchiveFailure()')).toContain("[result: [status: 'FAILURE', firstFailedStage: 'Post Archive']]");
    // image-digest.txt 的 fingerprint 只在產生時（Image Push）封存一次。
    expect(code.match(/archiveArtifacts\(artifacts: 'reports\/image-digest\.txt', fingerprint: true\)/g)?.length).toBe(1);
  });

  test('遮罩用秘密：只取本建置進入過的階段用過的憑證，Untrusted 只有拉取帳號與 Git 憑證；值只寫入 0600 檔（Req 2.4、15.2）', () => {
    const entries = [...specs.matchAll(/\[id: env\.(LM_[A-Z_]+_CREDENTIALS), kind: '(password|secret|file|ssh|envfile)', trusted: (true|false), stages: \[([^\]]*)\]\]/g)];
    expect(entries.length).toBe(11);
    // Supabase 金鑰檔（KEY=VALUE）以 envfile 遮罩：每行的 VALUE 各為一個秘密（plan.md D13）。
    expect(entries.filter((m) => m[2] === 'envfile').map((m) => [m[1], m[4]])).toEqual([
      ['LM_STAGING_STACK_ENV_CREDENTIALS', "'Staging Deploy'"], ['LM_PROD_STACK_ENV_CREDENTIALS', "'Production Deploy'"],
    ]);
    expect(specs).not.toMatch(/OPENAI|_DB_CREDENTIALS|SETUP_TOKEN|LM_JENKINS_API_CREDENTIALS/);
    expect(entries.filter((m) => m[3] === 'false').map((m) => m[1])).toEqual(['LM_REGISTRY_PULL_CREDENTIALS', 'LM_GIT_CREDENTIALS']);
    // 每個 trusted 憑證都以其使用階段限制；階段名稱屬於 ci/stages.mjs。
    const known = new Set(Object.values(STAGE));
    for (const m of entries.filter((e) => e[3] === 'true')) {
      const stages = [...m[4].matchAll(/'([^']+)'/g)].map((s) => s[1]);
      expect(stages.length).toBeGreaterThan(0);
      for (const s of stages) expect(known.has(s)).toBe(true);
    }
    // 環境變數中的每個憑證 ID 常數都存在（known_hosts、cosign 公鑰與 keepLog 帳號除外：非秘密或於封存後才使用）。
    for (const m of entries) expect(source).toMatch(new RegExp(`\\n    ${m[1]} = '[a-z0-9-]+'`));
    expect(specs).toContain("env.LM_TRUSTED == 'true' && (env.JOB_NAME ?: '').startsWith('release/')");
    expect(specs).toContain("(env.LM_STAGES_ENTERED ?: '').tokenize('|')");
    expect(functionBody('void enterStage(String name)')).toContain('env.LM_STAGES_ENTERED');
    // 每種憑證各一個 withCredentials；變數只有 LM_SCRUB_VALUE／LM_SCRUB_FILE（與 LM_SCRUB_USER），ID 先驗證格式。
    expect(stageSecret.match(/withCredentials\(\[/g)?.length).toBe(4);
    expect(stageSecret).toContain("String name = s.kind == 'envfile' ? \"cred-${id}.env\".toString() : \"cred-${id}\".toString()");
    expect(stageSecret).toContain("s.kind == 'file' || s.kind == 'envfile'");
    // ci/scrub.mjs 依 .env 副檔名逐行遮罩。
    expect(readFileSync(resolve(root, 'ci/scrub.mjs'), 'utf8')).toContain("ent.name.endsWith('.env')");
    for (const s of ["string(credentialsId: id, variable: 'LM_SCRUB_VALUE')", "passwordVariable: 'LM_SCRUB_VALUE'", "file(credentialsId: id, variable: 'LM_SCRUB_FILE')", "keyFileVariable: 'LM_SCRUB_FILE'"]) {
      expect(stageSecret).toContain(s);
    }
    expect(stageSecret).toContain('id ==~ /^[a-z0-9][a-z0-9-]{0,63}$/');
    expect(functionBody('void writeScrubValue()')).toContain(`printf '%s' "\${LM_SCRUB_VALUE:-}" > "$d/$LM_SCRUB_NAME"`);
    expect(functionBody('void writeScrubFile()')).toContain('cat -- "$LM_SCRUB_FILE" > "$d/$LM_SCRUB_NAME"');
    for (const fn of ['void writeScrubValue()', 'void writeScrubFile()']) {
      const body = functionBody(fn);
      inOrder(body, ['set +x', 'umask 077', 'mkdir -p -m 0700 "$d"', 'chmod 0700 "$d"']);
    }
    // 秘密值不出現在 echo、命令列參數或 Groovy 插值中。
    expect(code).not.toMatch(/echo[^\n]*\$\{?LM_SCRUB_VALUE/);
    expect(code).not.toMatch(/\$\{env\.LM_SCRUB_VALUE/);
    expect(code).not.toMatch(/--[a-z-]+ "?\$\{?LM_SCRUB_VALUE/);
    // 收尾無法取得秘密時只記錄憑證 ID。
    expect(functionBody('List stageScrubSecrets()')).toMatch(/catch \(Exception e\) \{[\s\S]*missing << \(s\.id/);
  });

  test('秘密目錄在遮罩後與 cleanup 刪除', () => {
    expect(functionBody('void removeScrubSecrets()')).toContain('rm -rf -- "$WORKSPACE_TMP/lm-scrub-secrets"');
    expect(functionBody('void removePostWork()')).toContain('rm -rf -- "$WORKSPACE_TMP/lm-post" "$WORKSPACE_TMP/lm-scrub-secrets" "$WORKSPACE_TMP/lm-keep-log"');
  });

  test('觸及秘密或 token 的收尾腳本第一行一律 set +x', () => {
    const scripts = tripleScripts.filter((s) => /LM_SCRUB_|lm-scrub-secrets|LM_KEEP_(DIR|TOKEN|USER)/.test(s));
    expect(scripts.length).toBeGreaterThanOrEqual(8);
    for (const s of scripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
  });

  test('依 label lm.ci.build=$BUILD_TAG 只清除本建置的容器、網路與卷，並確認沒有殘留（Req 2.6）', () => {
    for (const s of [
      'label="lm.ci.build=$BUILD_TAG"',
      'docker ps -aq --filter "label=$label"', 'docker rm -fv "$id"',
      'docker network ls -q --filter "label=$label"', 'docker network rm "$net"',
      'docker volume ls -q --filter "label=$label"', 'docker volume rm -f "$vol"',
      'exit 1',
    ]) expect(resources).toContain(s);
    expect(code).not.toMatch(/docker (system|container|network|volume|image) prune/);
    expect(resources).toContain("timeout(time: 5, unit: 'MINUTES')");
    // Rust 工具鏈映像只移除本建置的標籤；cargo 快取卷沒有建置 label，不會被移除（plan.md D3）。
    expect(resources).toContain('if [ -n "${LM_RUST_TOOLCHAIN_IMAGE:-}" ]; then');
    expect(resources).toContain('docker image rm "$LM_RUST_TOOLCHAIN_IMAGE" > /dev/null 2>&1 || true');
    expect(functionBody('void buildRustToolchain()')).not.toMatch(/docker volume create[^\n]*--label/);
    // 映像層級 Smoke_Test 的容器與網路也以完整建置標籤標記（不使用截斷後的名稱）。
    const smoke = readFileSync(resolve(root, 'ci/scripts/image-smoke.sh'), 'utf8');
    expect(smoke).toContain('--label "lm.ci.build=${label}"');
  });

  test('keepLog：只在 main 建置通過觀察期後，以專用帳號經 0600 token 檔呼叫 ci/keep-log.mjs（Req 21.6）', () => {
    expect(/LM_JENKINS_RETENTION_CREDENTIALS = '([^']+)'/.exec(source)?.[1]).toBe('lm-jenkins-api-retention');
    expect(keep).toContain("env.LM_TRUSTED != 'true' || env.LM_TRIGGER_KIND != 'main_push' || env.LM_PRD_OBSERVED != 'true'");
    inOrder(keep, [
      'credentialsId: env.LM_JENKINS_RETENTION_CREDENTIALS', 'set +x', 'umask 077', 'mkdir -m 0700 "$LM_KEEP_DIR"',
      `printf '%s' "$LM_KEEP_TOKEN_SRC" > "$LM_KEEP_DIR/token"`, 'inBuildImage {', 'LM_JENKINS_API_TOKEN_FILE="$LM_KEEP_DIR/token"',
      'bun ci/keep-log.mjs "$@"', 'finally {', 'rm -rf -- "$LM_KEEP_DIR"',
    ]);
    expect(keep).not.toContain('--main-record');
    expect(keep).toContain('set -- --job "$JOB_NAME" --number "$BUILD_NUMBER" --trigger "$LM_TRIGGER_KIND" --observed "$LM_PRD_OBSERVED"');
    expect(code.match(/credentialsId: env\.LM_JENKINS_RETENTION_CREDENTIALS/g)?.length).toBe(1);
    // keepLog 失敗只寫入摘要，不改變建置結果（Production 已切換）。
    expect(keep).not.toMatch(/currentBuild\.result|error\(/);
  });

  test('最終通知：所有收尾步驟後以當下結果呼叫 notifyAll，附失敗階段與 Release_Gate 說明（Req 22.2–22.4、22.7、22.8）', () => {
    inOrder(notify, [
      "env.LM_POST_RESULT_BEFORE == 'SUCCESS' ? (env.LM_POST_FAILED_STEP ?: '') : ''",
      'finalOutcome(currentBuild.currentResult',
      "gateSummaryText(readJsonFile('reports/build-record.json'), env.BUILD_URL ?: '')",
      'postNotifier()',
      "notifier.notifyAll(o.notify, [commit: env.GIT_COMMIT_FULL ?: '', failedStage: o.failedStage, gateSummary: gate])",
    ]);
    // 關卡說明只讀取遮罩後的封存副本，並跳脫 HTML。
    expect(notify).toContain('dir("${env.WORKSPACE_TMP}/lm-post/archive")');
    expect(functionBody('String gateSummaryText(Map record, String buildUrl)')).toContain('return htmlText(s)');
    expect(notify).toMatch(/catch \(Exception e\) \{\s*failure = e\.getClass\(\)\.getName\(\)\s*\}\s*if \(failure != null\) \{\s*echo "notifyFinal\/notify: \$\{failure\}"\s*echo '最終狀態通知失敗/);
    // Init 尚未載入 notify.groovy 時於收尾載入。
    expect(functionBody('def postNotifier()')).toContain("load('ci/notify.groovy')");
    expect([...code.matchAll(/\.notifyAll\(/g)].length).toBe(2);
  });
});

describe('同主機部署值（design.md 第 18.6 節）', () => {
  const envValue = (text, name) => new RegExp(`^\\s*${name} = '([^']*)'$`, 'm').exec(text)?.[1];

  test('Jenkinsfile、rollback 與 restore-drill 的 Deploy_Host 為 192.168.1.121:22，不再有佔位符', () => {
    for (const file of ['Jenkinsfile', 'ci/jenkins/pipelines/rollback.Jenkinsfile', 'ci/jenkins/pipelines/restore-drill.Jenkinsfile']) {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect({ file, host: envValue(text, 'LM_DEPLOY_HOST'), port: envValue(text, 'LM_DEPLOY_PORT') })
        .toEqual({ file, host: '192.168.1.121', port: '22' });
      expect({ file, placeholder: /deploy-host\.lan\.example|<deploy-host-ip>|<registry-ip>|<jenkins-ip>/.test(text) })
        .toEqual({ file, placeholder: false });
    }
  });

  test('Smoke_Test 的 LAN origin；Bun 版的 Database 名稱已移除（plan.md D13）', () => {
    expect(envValue(source, 'LM_STAGING_URL')).toBe('http://192.168.1.121:8081');
    expect(envValue(source, 'LM_PROD_URL')).toBe('http://192.168.1.121:8082');
    expect(envValue(source, 'LM_STAGING_DB_NAME')).toBeUndefined();
    expect(envValue(source, 'LM_PROD_DB_NAME')).toBeUndefined();
    // 兩個 URL 都通過 assertStagingConfig／assertProductionConfig 的格式檢查。
    const urlRe = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$/;
    for (const name of ['LM_STAGING_URL', 'LM_PROD_URL']) expect(urlRe.test(envValue(source, name))).toBe(true);
  });
});
