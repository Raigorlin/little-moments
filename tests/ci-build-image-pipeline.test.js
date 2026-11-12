// ci/jenkins/pipelines/build-image.Jenkinsfile 的靜態檢查（Req 3.1、3.2；tasks 13.10）。
// 本機沒有 Jenkins／Groovy／Docker，這裡只檢查結構、關鍵字與步驟順序，不能取代 Jenkins 的實際語法驗證或實際建置。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const source = readFileSync(resolve(root, 'ci/jenkins/pipelines/build-image.Jenkinsfile'), 'utf8');
const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

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
    // Groovy slashy regex（==~ /.../）：略過內容，避免其中的括號干擾配對。
    if (text[i] === '/' && /==~\s*$/.test(out)) {
      let j = i + 1;
      while (j < text.length && text[j] !== '/') { if (text[j] === '\\') j++; j++; }
      out += '//';
      i = j + 1;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** 取出 stage 區塊（到下一個 stage 或 post 為止）。 */
function stage(name) {
  const start = code.indexOf(`stage('${name}')`);
  if (start < 0) throw new Error(`找不到 stage ${name}`);
  const rest = code.slice(start + 1);
  const next = rest.search(/stage\('|\n  post \{/);
  return code.slice(start, next < 0 ? code.length : start + 1 + next);
}

/** 取出所有 ''' 腳本。 */
const scripts = [...code.matchAll(/'''([\s\S]*?)'''/g)].map((m) => m[1]);

const structure = stripCommentsAndStrings(source);

describe('build-image.Jenkinsfile 結構', () => {
  test('括號在註解與字串之外成對且順序正確', () => {
    const pairs = { ')': '(', '}': '{', ']': '[' };
    const stack = [];
    for (const ch of structure) {
      if ('({['.includes(ch)) stack.push(ch);
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch]);
    }
    expect(stack).toEqual([]);
  });

  test('單一 Declarative pipeline，Trusted Agent、必要 options、沒有任何建置參數', () => {
    expect(structure.match(/^pipeline\s*\{/gm)?.length).toBe(1);
    expect(code).toContain("agent { label 'lm-trusted' }");
    for (const opt of ['skipDefaultCheckout()', 'timestamps()', 'disableResume()', 'disableConcurrentBuilds()',
      "timeout(time: 120, unit: 'MINUTES')", "buildDiscarder(logRotator(daysToKeepStr: '90'))"]) {
      expect(code).toContain(opt);
    }
    expect(code).not.toMatch(/parameters\s*\{|booleanParam|string\(name:|choice\(|\binput\(/);
    expect(code).not.toMatch(/\b(SKIP|BYPASS|FORCE|OVERWRITE|ALLOW)_[A-Z]/);
    expect(code).not.toMatch(/--force\b|params\./);
  });

  test('階段依序為 Init → Validate → Build → Verify Toolchain → Push', () => {
    const names = [...code.matchAll(/stage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(names).toEqual(['Init', 'Validate', 'Build', 'Verify Toolchain', 'Push']);
  });

  test('只能由 infra/build-image 執行、拒絕 Replay、使用完整 40 字元 Commit SHA', () => {
    const init = stage('Init');
    expect(init).toContain("env.JOB_NAME != 'infra/build-image'");
    expect(init).toContain('isReplay()');
    expect(code).toContain("getBuildCauses('org.jenkinsci.plugins.workflow.cps.replay.ReplayCause')");
    expect(init).toContain('checkout scm');
    expect(init).toContain('sha ==~ /^[0-9a-f]{40}$/');
    expect(init).toContain('env.LM_BI_TAG = sha');
  });

  test('post：封存 reports、移除本機標籤與暫存目錄、cleanWs', () => {
    const post = code.slice(code.indexOf('\n  post {'));
    expect(post).toMatch(/always \{\s*archiveArtifacts\(artifacts: 'reports\/\*\*', allowEmptyArchive: true\)/);
    expect(post).toMatch(/cleanup \{[\s\S]*docker image rm "\$LM_BI_REF"[\s\S]*rm -rf "\$LM_BI_DIR"[\s\S]*cleanWs\(/);
  });
});

describe('shell 與憑證安全', () => {
  test('沒有 Groovy 字串插值（不使用雙引號字串）', () => {
    const withoutSingle = code.replace(/'''[\s\S]*?'''/g, "''").replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    expect(withoutSingle).not.toContain('"');
  });

  test('每個 sh 的 script 都是單引號字串', () => {
    const args = [...code.matchAll(/\bscript:\s*([^\n]+)/g)].map((m) => m[1].trim());
    expect(args.length).toBeGreaterThanOrEqual(6);
    for (const a of args) expect(a.startsWith("'")).toBe(true);
  });

  test('憑證只以 withCredentials 綁定 lm-registry-push，觸及秘密的腳本第一行為 set +x', () => {
    expect(/LM_REGISTRY_PUSH_CREDENTIALS = '([^']+)'/.exec(code)?.[1]).toBe('lm-registry-push');
    expect(code).not.toMatch(/\bcredentials\(/);
    expect([...code.matchAll(/credentialsId:/g)].length).toBe(1);
    const push = stage('Push');
    expect(push).toMatch(/withCredentials\(\[usernamePassword\(\s*credentialsId: env\.LM_REGISTRY_PUSH_CREDENTIALS,\s*usernameVariable: 'LM_PUSH_USER',\s*passwordVariable: 'LM_PUSH_PASSWORD'/);
    const secretScripts = scripts.filter((s) => /LM_PUSH_(USER|PASSWORD)/.test(s));
    expect(secretScripts.length).toBe(1);
    for (const s of secretScripts) expect(s.trim().split('\n')[0].trim()).toBe('set +x');
    // 秘密變數只出現在 withCredentials 的綁定與其內的單一腳本。
    expect([...code.matchAll(/LM_PUSH_PASSWORD/g)].length).toBe(2);
    expect(push.indexOf('withCredentials(')).toBeLessThan(push.indexOf('"$LM_PUSH_PASSWORD"'));
  });

  test('docker 登入：本建置暫存目錄 0700、trap 刪除、--password-stdin', () => {
    const s = scripts.find((x) => x.includes('docker login'));
    expect(s).toBeTruthy();
    expect(s).toContain('DOCKER_CONFIG="$LM_BI_DIR/docker-push"');
    expect(s).toContain('mkdir -m 0700 "$DOCKER_CONFIG"');
    expect(s).toMatch(/trap '[^']*rm -rf "\$DOCKER_CONFIG"' EXIT/);
    expect(s.indexOf('trap ')).toBeLessThan(s.indexOf('docker login'));
    expect(s).toContain('printf \'%s\' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry"');
    expect(s).not.toMatch(/--password[ =]"?\$/);
  });

  test('所有容器不發布連接埠、不使用 host 網路、不以 privileged 執行', () => {
    const shell = scripts.join('\n');
    expect(shell).not.toMatch(/--network[ =]host|--net[ =]host|--privileged|--cap-add|--pid[ =]host|docker\.sock/);
    const runs = [...shell.matchAll(/docker run --rm[\s\S]*?"\$@"/g)];
    expect(runs.length).toBe(2);
    expect([...shell.matchAll(/docker run\b/g)].length).toBe(2);
    for (const run of runs) {
      expect(run[0]).not.toMatch(/\s(-p|--publish|--publish-all|-P)[\s=]/);
      expect(run[0]).toContain('--cap-drop ALL');
      expect(run[0]).toContain('--read-only');
      expect(run[0]).toContain('--security-opt no-new-privileges:true');
      expect(run[0]).toContain('--user "$(id -u):$(id -g)"');
    }
  });
});

describe('PLACEHOLDER 與版本檢查（fail closed）', () => {
  test('Validate 拒絕 sha256:<digest> 與 ARG <...> PLACEHOLDER、未固定的 FROM，並比對 ci/toolchain.json', () => {
    const v = stage('Validate');
    expect(v).toContain("grep -v '^[[:space:]]*#' \"$f\"");
    expect(v).toContain("grep -n 'sha256:<' \"$code\"");
    expect(v).toMatch(/ARG\[\[:space:\]\]\+\[A-Za-z0-9_\]\+=</);
    expect(v).toContain('@sha256:[0-9a-f]{64}');
    expect(v).toContain('[ "$froms" != "$pinned" ]');
    expect(v).toContain('for name in BUN_SHA256 NODE_SHA256; do');
    expect(v).toContain('"$(arg_value BUN_VERSION)" != "$bun_v"');
    expect(v).toContain('"$(arg_value NODE_VERSION)" != "$node_v"');
    expect(v).toMatch(/1\.3\.\*\) ;;/);
    expect(v).toMatch(/if \(rc != 0\) \{[\s\S]*error\(/);
  });

  test('目前 repo 的 Dockerfile 已填入實際值，符合 Validate 的模式', () => {
    const dockerfile = readFileSync(resolve(root, 'ci/build-image/Dockerfile'), 'utf8');
    const codeLines = dockerfile.split('\n').filter((l) => !/^\s*#/.test(l));
    const placeholders = codeLines.filter((l) => l.includes('sha256:<') || /^\s*ARG\s+[A-Za-z0-9_]+=</.test(l));
    const from = codeLines.filter((l) => /^\s*FROM\s/i.test(l));
    const pinned = from.filter((l) => /^\s*FROM\s+[^\s@]+@sha256:[0-9a-f]{64}(\s+AS\s+[A-Za-z0-9_.-]+)?\s*$/.test(l));
    expect(placeholders).toEqual([]);
    expect(from.length).toBeGreaterThan(0);
    expect(pinned).toEqual(from);
    for (const name of ['BUN_SHA256', 'NODE_SHA256']) {
      expect(codeLines.some((l) => new RegExp(`^\\s*ARG\\s+${name}=[0-9a-f]{64}\\s*$`).test(l))).toBe(true);
    }
    // syntax 前端同樣以 digest 固定。
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:1\.10@sha256:[0-9a-f]{64}$/);
    // 未填入時的 sha256 檢查仍保留（fail closed）。
    expect(dockerfile).toContain('case "${NODE_SHA256}" in "<"*)');
    expect(dockerfile).toContain('case "${BUN_SHA256}" in "<"*)');
  });

  test('Node.js 使用 .tar.gz 發行檔：基底映像沒有 xz，先校驗再以 gzip 解壓', () => {
    const dockerfile = readFileSync(resolve(root, 'ci/build-image/Dockerfile'), 'utf8');
    const code = dockerfile.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).toContain('/node-v${NODE_VERSION}-linux-x64.tar.gz"');
    expect(code).not.toMatch(/tar\.xz|-xJf/);
    const check = code.indexOf('echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c -');
    const extract = code.indexOf('tar -xzf /tmp/node.tar.gz');
    expect(check).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(check);
  });

  test('crane 只以 digest 引用（LAN Registry 的鏡像）；格式不符時 Init 失敗', () => {
    const crane = /LM_CRANE_IMAGE = '([^']+)'/.exec(code)?.[1];
    expect(crane).toMatch(/^registry\.our-littlemoments\.com:8443\/little-moments\/mirror\/crane@sha256:[0-9a-f]{64}$/);
    expect(stage('Init')).toContain("assertDigestRef('LM_CRANE_IMAGE', env.LM_CRANE_IMAGE)");
    const groovyRe = /void assertDigestRef[\s\S]*?ref ==~ \/(.+)\/\)\)/.exec(code)?.[1];
    expect(groovyRe).toBeTruthy();
    const re = new RegExp(groovyRe.replace(/\\\//g, '/'));
    expect(re.test(crane)).toBe(true);
    expect(re.test('registry.our-littlemoments.com:8443/little-moments/mirror/crane@sha256:<digest>')).toBe(false);
    expect(re.test('registry.our-littlemoments.com:8443/little-moments/mirror/crane:latest')).toBe(false);
    // 與根目錄 Jenkinsfile 使用同一個 crane 映像。
    const root_ = readFileSync(resolve(root, 'Jenkinsfile'), 'utf8');
    expect(/LM_CRANE_IMAGE = '([^']+)'/.exec(root_)?.[1]).toBe(crane);
  });
});

describe('建置、工具鏈驗證與推送順序（Req 3.1、3.2）', () => {
  test('docker build：只含 Dockerfile 的 context、--no-cache、不可變的 commit 標籤與 OCI 標籤', () => {
    const b = stage('Build');
    expect(b).toContain("env.LM_BI_REF = env.LM_BI_REPO + ':' + env.LM_BI_TAG");
    expect(b).toContain('cp "$LM_BI_DOCKERFILE" "$ctx/Dockerfile"');
    expect(b).toContain('docker build --no-cache --file "$ctx/Dockerfile" --tag "$LM_BI_REF"');
    for (const l of ['org.opencontainers.image.revision=$GIT_COMMIT_FULL', 'org.opencontainers.image.version=$LM_BI_TAG',
      'lm.toolchain.bun=$LM_TC_BUN', 'lm.toolchain.node=$LM_TC_NODE', 'lm.toolchain.chromium=$LM_TC_CHROMIUM']) {
      expect(b).toContain(`--label "${l}"`);
    }
    expect(b).not.toMatch(/--build-arg/);
    expect(/LM_BI_REPO = '([^']+)'/.exec(code)?.[1]).toBe('registry.our-littlemoments.com:8443/little-moments/build-image');
  });

  test('在推送前於剛建置的映像內（無網路、唯讀）執行 verify-toolchain 與 verify-env', () => {
    const v = stage('Verify Toolchain');
    expect(v).toContain('--network none --read-only --cap-drop ALL --security-opt no-new-privileges:true');
    expect(v).toContain('--mount "type=bind,src=$WORKSPACE,dst=/src,readonly"');
    expect(v).toContain('"$LM_BI_ID" "$@"');
    expect(v).toContain('in_image ci/verify-toolchain.mjs --expected "$LM_TOOLCHAIN" --out /out/toolchain.json');
    expect(v).toContain('in_image ci/verify-env.mjs --out /out/env.json');
    expect(v).toMatch(/if \(rc == 1\) \{\s*error\('[^']*不一致[^']*不推送'\)/);
    expect(v).toContain("record.ok != true");
    expect(v).toContain("env.LM_BI_VERIFIED = 'true'");
    expect(code.indexOf("stage('Verify Toolchain')")).toBeLessThan(code.indexOf('docker push'));
    const push = stage('Push');
    expect(push.indexOf("env.LM_BI_VERIFIED != 'true'")).toBeLessThan(push.indexOf('withCredentials('));
  });

  test('拒絕覆寫既有標籤：crane digest 成功即中止，非 404 查詢失敗也中止，皆在 docker push 之前', () => {
    const s = scripts.find((x) => x.includes('docker push'));
    const check = s.indexOf('crane digest "$LM_BI_REF" > "$out/existing-digest.txt"');
    const refuse = s.indexOf('拒絕覆寫');
    const notFound = s.indexOf("grep -Eq 'MANIFEST_UNKNOWN|unexpected status code 404'");
    const push = s.indexOf('docker push --quiet "$LM_BI_REF"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(refuse);
    expect(refuse).toBeLessThan(notFound);
    expect(notFound).toBeLessThan(push);
    expect(s).toMatch(/if \[ "\$rc" -eq 0 \]; then[\s\S]*?exit 10/);
    // 推送前確認本機標籤仍指向通過驗證的 image ID。
    expect(s.indexOf('!= "$LM_BI_ID"')).toBeLessThan(push);
    expect(s).not.toMatch(/crane (tag|copy|cp|delete|mutate)/);
  });

  test('digest 驗證：本機 RepoDigest、標籤 digest 與以 digest 查詢三者一致後才寫入 build-image-digest.txt', () => {
    const s = scripts.find((x) => x.includes('docker push'));
    const order = [
      'docker push --quiet "$LM_BI_REF"',
      '{{range .RepoDigests}}{{println .}}{{end}}',
      "grep -Eqx 'sha256:[0-9a-f]{64}'",
      'remote="$(crane digest "$LM_BI_REF"',
      'by_digest="$(crane digest "$LM_BI_REPO@$digest"',
      '[ "$remote" != "$digest" ] || [ "$by_digest" != "$digest" ]',
      "printf '%s@%s\\\\n' \"$LM_BI_REPO\" \"$digest\" > reports/build-image-digest.txt",
    ];
    const idx = order.map((x) => s.indexOf(x));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(s.indexOf('rm -f reports/build-image-digest.txt')).toBeLessThan(idx[0]);
  });

  test('digest 檔格式再驗證，封存並 fingerprint，建置描述含 BUILD_IMAGE 值', () => {
    const push = stage('Push');
    expect(push).toContain("ref.substring(prefix.length()) ==~ /^sha256:[0-9a-f]{64}$/");
    expect(push).toContain("content != ref + '\\n'");
    expect(push).toContain("archiveArtifacts(artifacts: 'reports/build-image-digest.txt', fingerprint: true)");
    expect(push).toContain("currentBuild.description = 'BUILD_IMAGE = ' + ref");
    expect(push.indexOf("readFile('reports/build-image-digest.txt')")).toBeLessThan(push.indexOf('fingerprint: true'));
    for (const rc of [10, 11, 12, 13, 14, 15, 16, 20]) expect(push).toContain(`pushRc == ${rc}`);
  });

  test('BUILD_IMAGE 的 repository 與其他 Pipeline 引用的相同', () => {
    const repo = /LM_BI_REPO = '([^']+)'/.exec(code)?.[1];
    for (const f of ['Jenkinsfile', 'ci/jenkins/pipelines/rollback.Jenkinsfile', 'ci/jenkins/pipelines/digest-lookup.Jenkinsfile']) {
      const ref = /BUILD_IMAGE = '([^']+)'/.exec(readFileSync(resolve(root, f), 'utf8'))?.[1];
      expect(ref?.split('@')[0]).toBe(repo);
    }
  });
});
