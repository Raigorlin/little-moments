// deploy/jenkins 的靜態檢查（tasks 19.3）：controller 與兩個 agent 的 Compose、Dockerfile、plugin 清單、
// untrusted agent 的防火牆腳本與 systemd 設定。只讀檔與解析 YAML，不執行 Docker、iptables 或 systemd；
// 實際的隔離須在 Jenkins 主機上驗證。
import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const DIR = 'deploy/jenkins';
const CONTROLLER = `${DIR}/controller`;
const AGENT = `${DIR}/agent`;
const FW = `${AGENT}/untrusted`;

/** 非註解、非空白的行。 */
const codeLines = (text) => text.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

const controller = YAML.parse(read(`${CONTROLLER}/compose.yaml`));
const trusted = YAML.parse(read(`${AGENT}/trusted.compose.yaml`));
const untrusted = YAML.parse(read(`${AGENT}/untrusted.compose.yaml`));
const casc = YAML.parse(read('ci/jenkins/casc.yaml'));
const cascNodes = Object.fromEntries(casc.jenkins.nodes.map((n) => [n.permanent.name, n.permanent]));

/** compose 的 command 陣列中某個旗標之後的值。 */
const argAfter = (command, flag) => {
  const i = command.indexOf(flag);
  return i === -1 ? undefined : command[i + 1];
};
/** 短語法 volume 的來源（以最後兩個 `:` 之前為來源，容許 `${VAR:?}` 內含的冒號）。 */
const volumeParts = (v) => {
  const m = /^(.*?):(\/[^:]*)(?::(ro|rw))?$/.exec(v.replace(/^\$\{[^}]*\}/, (s) => s.replace(/:/g, '\u0000')));
  if (!m) throw new Error(`unparsable volume: ${v}`);
  return { source: m[1].replace(/\u0000/g, ':'), target: m[2], mode: m[3] };
};

const AGENTS = [
  { name: 'lm-trusted-1', compose: trusted, file: `${AGENT}/trusted.compose.yaml`, workDir: '/var/lib/jenkins-agent' },
  { name: 'lm-untrusted-1', compose: untrusted, file: `${AGENT}/untrusted.compose.yaml`, workDir: '/var/lib/jenkins-untrusted' },
];

describe('agent compose', () => {
  test('untrusted 絕不掛載主機的 /var/run/docker.sock：socket 來源是 ${SOCK…}', () => {
    const svc = untrusted.services['lm-untrusted-1'];
    const vols = svc.volumes.map(volumeParts);
    expect(vols.filter((v) => v.source === '/var/run/docker.sock')).toEqual([]);
    const sock = vols.filter((v) => v.target === '/var/run/docker.sock');
    expect(sock.length).toBe(1);
    expect(sock[0].source).toMatch(/^\$\{SOCK[:}]/);
    expect(svc.group_add).toEqual(['${SOCK_GID:?}']);
    // 未解析的文字中也不出現主機 socket 作為來源（含長語法）。
    expect(codeLines(read(`${AGENT}/untrusted.compose.yaml`)).join('\n')).not.toMatch(/(^|[\s"'-])\/var\/run\/docker\.sock:/m);
    expect(Object.keys(untrusted.services)).toEqual(['lm-untrusted-1']);
    expect(untrusted.name).toBe('lm-untrusted-agent');
    expect(svc.image).toBe('lm-untrusted-agent');
  });

  test('trusted 掛載主機 docker.sock 並加入主機 docker 群組；工作目錄為 /var/lib/jenkins-agent', () => {
    const svc = trusted.services['lm-trusted-1'];
    expect(svc.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(svc.group_add).toEqual(['${DOCKER_GID:?DOCKER_GID is required}']);
    expect(argAfter(svc.command, '-workDir')).toBe('/var/lib/jenkins-agent');
    expect(cascNodes['lm-trusted-1'].remoteFS).toBe('/var/lib/jenkins-agent');
    expect(Object.keys(trusted.services)).toEqual(['lm-trusted-1']);
    expect(trusted.name).toBe('lm-jenkins-agent');
  });

  for (const a of AGENTS) {
    test(`${a.name}：-workDir、同路徑 volume 與 casc.yaml 的 remoteFS 一致`, () => {
      const svc = a.compose.services[a.name];
      expect(argAfter(svc.command, '-workDir')).toBe(a.workDir);
      expect(svc.volumes).toContain(`${a.workDir}:${a.workDir}`);
      expect(cascNodes[a.name]?.remoteFS).toBe(a.workDir);
    });

    test(`${a.name}：名稱與 casc.yaml 的 node 一致，WebSocket、secret 檔唯讀掛載`, () => {
      const svc = a.compose.services[a.name];
      expect(Object.keys(cascNodes)).toContain(argAfter(svc.command, '-name'));
      expect(argAfter(svc.command, '-name')).toBe(a.name);
      expect(cascNodes[a.name].launcher.inbound.webSocket).toBe(true);
      expect(svc.command).toContain('-webSocket');
      expect(argAfter(svc.command, '-secret')).toBe('@/run/secrets/agent-secret');
      expect(argAfter(svc.command, '-url')).toBe('${LM_JENKINS_URL:?LM_JENKINS_URL is required}');
      expect(svc.entrypoint).toEqual(['java', '-jar', '/usr/share/jenkins/agent.jar']);
      expect(svc.volumes).toContain(`./${a.name}.secret:/run/secrets/agent-secret:ro`);
      expect(svc.build).toEqual({ context: '.', dockerfile: 'Dockerfile' });
      expect(svc.ports).toBeUndefined();
    });
  }

  test('agent 映像只加入 docker CLI 與 cli-plugins；.dockerignore 排除全部、.gitignore 排除 secret 與 .env', () => {
    const code = codeLines(read(`${AGENT}/Dockerfile`));
    expect(code).toEqual([
      'FROM jenkins/inbound-agent:latest-jdk21',
      'COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker',
      'COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins',
    ]);
    expect(codeLines(read(`${AGENT}/.dockerignore`)).map((l) => l.trim())).toEqual(['*']);
    const ignored = codeLines(read(`${AGENT}/.gitignore`)).map((l) => l.trim());
    for (const e of ['*.secret', '.env']) expect(ignored).toContain(e);
  });
});

describe('controller', () => {
  const svc = controller.services.jenkins;

  test('只綁定 ${LM_JENKINS_LAN_IP…}:8080:8080；沒有 50000、沒有 0.0.0.0', () => {
    expect(controller.name).toBe('lm-jenkins');
    expect(Object.keys(controller.services)).toEqual(['jenkins']);
    expect(svc.ports).toEqual(['${LM_JENKINS_LAN_IP:?LM_JENKINS_LAN_IP is required}:8080:8080']);
    expect(svc.expose).toBeUndefined();
    const code = codeLines(read(`${CONTROLLER}/compose.yaml`)).join('\n');
    expect(code).not.toContain('50000');
    expect(code).not.toContain('0.0.0.0');
    expect(svc.restart).toBe('unless-stopped');
  });

  test('casc 與 secrets 唯讀掛載；CASC_JENKINS_CONFIG、LM_CASC_DIR、SECRETS', () => {
    expect(svc.volumes).toEqual([
      'jenkins_home:/var/jenkins_home',
      './casc:/var/jenkins_home/casc:ro',
      './secrets:/run/secrets:ro',
    ]);
    expect(svc.environment).toEqual({
      CASC_JENKINS_CONFIG: '/var/jenkins_home/casc',
      LM_CASC_DIR: '/var/jenkins_home/casc',
      SECRETS: '/run/secrets',
    });
    // casc.yaml 以 LM_CASC_DIR 找到 jobs.groovy。
    expect(casc.jobs).toEqual([{ file: '${LM_CASC_DIR:-/var/jenkins_home/casc}/jobs.groovy' }]);
    expect(Object.keys(controller.volumes)).toEqual(['jenkins_home']);
  });

  test('網路為 default 與外部 proxy', () => {
    expect(svc.networks).toEqual(['default', 'proxy']);
    expect(controller.networks).toEqual({ proxy: { external: true } });
  });

  test('Dockerfile：lts-jdk21、關閉 setup wizard、COPY --chown、configuration-as-code／job-dsl 的 ls 檢查', () => {
    const code = codeLines(read(`${CONTROLLER}/Dockerfile`)).join('\n').replace(/\\\n\s*/g, ' ');
    expect(code).toMatch(/^FROM jenkins\/jenkins:lts-jdk21$/m);
    expect(code).toContain('ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"');
    expect(code).toContain('COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt');
    expect(code).toContain('jenkins-plugin-cli --plugin-download-directory /usr/share/jenkins/ref/plugins --plugin-file /usr/share/jenkins/ref/plugins.txt');
    expect(code).toContain('&& ls /usr/share/jenkins/ref/plugins/configuration-as-code.?pi /usr/share/jenkins/ref/plugins/job-dsl.?pi > /dev/null');
    expect(code.match(/^COPY /gm)).toHaveLength(1);
  });

  test('.dockerignore 只允許 plugins.txt；.gitignore 排除 secrets、casc 與 .env', () => {
    expect(codeLines(read(`${CONTROLLER}/.dockerignore`)).map((l) => l.trim())).toEqual(['*', '!plugins.txt']);
    const ignored = codeLines(read(`${CONTROLLER}/.gitignore`)).map((l) => l.trim());
    for (const e of ['secrets/', 'secrets-dummy/', 'casc/', '.env']) expect(ignored).toContain(e);
  });

  test('plugins.txt 與 ci/jenkins/README.md 的必要 plugins 表相同（集合相同、無重複）', () => {
    const plugins = codeLines(read(`${CONTROLLER}/plugins.txt`)).map((l) => l.trim());
    expect(plugins.every((p) => /^[a-z0-9-]+$/.test(p))).toBe(true);
    expect(new Set(plugins).size).toBe(plugins.length);

    const readme = read('ci/jenkins/README.md');
    const section = /^## 必要 plugins\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1];
    expect(section).toBeTruthy();
    const rows = section.split('\n').filter((l) => /^\|\s*`/.test(l));
    const fromReadme = rows.flatMap((l) => [...l.split('|')[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
    expect(new Set(fromReadme).size).toBe(fromReadme.length);
    expect([...plugins].sort()).toEqual([...fromReadme].sort());
    expect(plugins).toHaveLength(25);
  });
});

describe('untrusted agent 的防火牆與 rootless Docker', () => {
  const script = read(`${FW}/lm-untrusted-fw`);
  const code = codeLines(script).join('\n');

  test('POSIX sh、set -eu；HOST 自 /etc/default/lm-untrusted-fw 的 LM_JENKINS_HOST_IP 讀取，缺少時失敗', () => {
    expect(script.split('\n')[0]).toBe('#!/bin/sh');
    expect(code).toMatch(/^set -eu$/m);
    expect(code).toContain('CONF=/etc/default/lm-untrusted-fw');
    expect(code).toContain('[ -r "$CONF" ] || {');
    expect(code).toContain('. "$CONF"');
    expect(code).toContain('HOST=${LM_JENKINS_HOST_IP:-}');
    expect(code).toMatch(/\[ -n "\$HOST" \] \|\| \{ [^}]*exit 1; \}/);
    // 沒有寫死的 IP 位址（網段清單除外）。
    expect(code).not.toMatch(/HOST=\d/);
    // 讀取設定與檢查都在第一條 iptables 規則之前。
    expect(code.indexOf('[ -n "$HOST" ]')).toBeLessThan(code.indexOf('iptables'));
    const example = codeLines(read(`${FW}/lm-untrusted-fw.default.example`)).map((l) => l.trim());
    expect(example).toEqual(['LM_JENKINS_HOST_IP=<lan-ip>']);
  });

  test('IPv4：丟棄 REPLY，只允許 DNS、HOST:8080 與 HOST:8443，拒絕本機與私有網段', () => {
    const rules = [...code.matchAll(/^\s*iptables -A "\$C" (.*)$/gm)].map((m) => m[1]);
    expect(rules).toEqual([
      '-m conntrack --ctdir REPLY -j DROP',
      '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      '-p udp --dport 53 -j RETURN',
      '-p tcp --dport 53 -j RETURN',
      '-p tcp -m conntrack --ctorigdst "$HOST" --ctorigdstport 8080 -j RETURN',
      '-p tcp -m conntrack --ctorigdst "$HOST" --ctorigdstport 8443 -j RETURN',
      '-m addrtype --dst-type LOCAL -j REJECT',
      '-d "$net" -j REJECT',
    ]);
    const nets = /for net in ([^;]+); do/.exec(code)?.[1].trim().split(/\s+/);
    expect(nets).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']);
    const allowedPorts = [...code.matchAll(/--(?:dport|ctorigdstport) (\d+) -j RETURN/g)].map((m) => m[1]);
    expect([...new Set(allowedPorts)].sort()).toEqual(['53', '8080', '8443']);
  });

  test('owner 規則套用於 lm-untrusted 的 uid 與 subuid 範圍；IPv6 全部拒絕', () => {
    expect(code).toContain('OWNER=$(id -u lm-untrusted)');
    expect(code).toContain(`SUB=$(awk -F: '$1=="lm-untrusted"{print $2 "-" $2+$3-1}' /etc/subuid)`);
    for (const t of ['iptables', 'ip6tables']) {
      expect(code).toContain(`${t} -C OUTPUT -m owner --uid-owner "$o" -j "$C" 2>/dev/null || ${t} -I OUTPUT -m owner --uid-owner "$o" -j "$C"`);
    }
    const v6 = [...code.matchAll(/^\s*ip6tables -A "\$C" (.*)$/gm)].map((m) => m[1]);
    expect(v6).toEqual(['-j REJECT']);
  });

  test('service 範本：oneshot，Before= 且 RequiredBy=user@@LM_UNTRUSTED_UID@.service', () => {
    const unit = codeLines(read(`${FW}/lm-untrusted-fw.service.in`)).map((l) => l.trim());
    for (const l of ['[Unit]', 'Before=user@@LM_UNTRUSTED_UID@.service', '[Service]', 'Type=oneshot', 'RemainAfterExit=yes',
      'ExecStart=/usr/local/sbin/lm-untrusted-fw', '[Install]', 'WantedBy=multi-user.target', 'RequiredBy=user@@LM_UNTRUSTED_UID@.service']) {
      expect(unit).toContain(l);
    }
    expect(unit.some((l) => l.startsWith('Description='))).toBe(true);
    // 條件不成立時 unit 視為成功，會讓 user manager 在沒有防火牆時啟動。
    expect(unit.some((l) => l.startsWith('Condition'))).toBe(false);
  });

  test('rootless Docker override：關閉 detach-netns 並使用 slirp4netns', () => {
    const conf = codeLines(read(`${FW}/docker-rootless-override.conf`)).map((l) => l.trim());
    expect(conf).toEqual([
      '[Service]',
      'Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false',
      'Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns',
    ]);
  });
});

describe('deploy/jenkins 的所有檔案', () => {
  // 與各目錄 .gitignore 相同的排除項目：主機上的秘密與複本不屬於 repository。
  const IGNORED_DIRS = new Set(['secrets', 'secrets-dummy', 'casc']);
  const isIgnoredFile = (name) => name === '.env' || name.endsWith('.secret');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return IGNORED_DIRS.has(e.name) ? [] : walk(p);
    return isIgnoredFile(e.name) ? [] : [p];
  });
  const files = walk(resolve(root, DIR)).map((p) => relative(root, p).replace(/\\/g, '/'));

  test('包含 controller、agent 與 untrusted 的全部檔案', () => {
    for (const f of [
      `${CONTROLLER}/Dockerfile`, `${CONTROLLER}/.dockerignore`, `${CONTROLLER}/plugins.txt`, `${CONTROLLER}/compose.yaml`,
      `${CONTROLLER}/.gitignore`, `${CONTROLLER}/.env.example`,
      `${AGENT}/Dockerfile`, `${AGENT}/.dockerignore`, `${AGENT}/.gitignore`, `${AGENT}/.env.example`,
      `${AGENT}/trusted.compose.yaml`, `${AGENT}/untrusted.compose.yaml`,
      `${FW}/lm-untrusted-fw`, `${FW}/lm-untrusted-fw.default.example`, `${FW}/lm-untrusted-fw.service.in`,
      `${FW}/docker-rootless-override.conf`,
    ]) expect(files).toContain(f);
  });

  test('README.md 提到 deploy/jenkins 的每個檔案（以 deploy/jenkins 之下的相對路徑）', () => {
    expect(files).toContain(`${DIR}/README.md`);
    const readme = read(`${DIR}/README.md`);
    for (const rel of files.map((f) => f.slice(DIR.length + 1)).filter((r) => r !== 'README.md')) {
      expect({ file: rel, mentioned: readme.includes(rel) }).toEqual({ file: rel, mentioned: true });
    }
  });

  for (const f of files) {
    test(`${f}：UTF-8 無 BOM、LF、沒有秘密字面值`, () => {
      const buf = readFileSync(resolve(root, f));
      expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf).toBe(false);
      const text = buf.toString('utf8');
      expect(text.includes('\r')).toBe(false);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text).not.toMatch(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/);
      expect(text).not.toMatch(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
      expect(text).not.toMatch(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/);
      expect(text.match(/\b[0-9a-f]{32,}\b/gi)).toBeNull();
      for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) expect(m[0]).toMatch(/^[a-z/]+$/);
      // .env 範本的值都是 <…> 佔位符。
      if (f.endsWith('.example')) {
        for (const l of codeLines(text)) expect(l).toMatch(/^[A-Z][A-Z0-9_]*=.*<[^>]+>/);
      }
    });
  }
});
