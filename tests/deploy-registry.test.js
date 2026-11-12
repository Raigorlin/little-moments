// deploy/registry 的靜態檢查（tasks 19.4）：Compose 的連接埠與能力、鏡像清單與腳本、trivy-db timer。
// 只讀檔，不執行 Docker、crane 或 systemd；mirror.sh 的實際複製須在 Registry 主機上驗證。
import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const DIR = 'deploy/registry';
const compose = YAML.parse(read(`${DIR}/compose.yaml`));

/** 非註解、非空白的行。 */
const codeLines = (text) => text.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

describe('deploy/registry/compose.yaml', () => {
  test('proxy 只在 LAN IP 發布 8443:8443（主機 443 屬於 Nginx Proxy Manager）；registry 不發布連接埠', () => {
    expect(compose.services.proxy.ports).toEqual(['${LM_REGISTRY_LAN_IP:?LM_REGISTRY_LAN_IP is required}:8443:8443']);
    expect(compose.services.registry.ports).toBeUndefined();
    expect(compose.services.registry.expose).toBeUndefined();
    // Caddyfile 在容器內監聽同一個連接埠。
    expect(read(`${DIR}/Caddyfile`)).toContain('https://{$LM_REGISTRY_HOST}:8443 {');
  });

  test('只有 proxy 加回 NET_BIND_SERVICE；兩個服務都 cap_drop ALL', () => {
    for (const svc of Object.values(compose.services)) expect(svc.cap_drop).toEqual(['ALL']);
    const withCapAdd = Object.entries(compose.services).filter(([, s]) => s.cap_add !== undefined).map(([n]) => n);
    expect(withCapAdd).toEqual(['proxy']);
    expect(compose.services.proxy.cap_add).toEqual(['NET_BIND_SERVICE']);
  });

  test('映像以上游 digest 固定；htpasswd.example 的 hash-password 使用同一個 caddy 映像', () => {
    expect(compose.services.proxy.image).toBe('caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb');
    expect(compose.services.registry.image).toBe('registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e');
    expect(read(`${DIR}/htpasswd.example`)).toContain(`docker run --rm -i ${compose.services.proxy.image} caddy hash-password`);
    expect(read(`${DIR}/compose.yaml`)).toContain('/etc/docker/certs.d/<LM_REGISTRY_HOST>:8443/ca.crt');
  });

  test('.gitignore 排除秘密、憑證、CA 目錄與 .env', () => {
    const entries = codeLines(read(`${DIR}/.gitignore`)).map((l) => l.trim());
    for (const e of ['secrets/', 'htpasswd', '*.key', '*.crt', '*.pem', 'ca/', '.env']) expect(entries).toContain(e);
  });
});

describe('mirror.list 與 mirror.sh', () => {
  const list = codeLines(read(`${DIR}/mirror.list`)).map((l) => l.trim().split(/\s+/));

  test('mirror.list 依序列出 8 個上游映像（含 tag）與名稱，與 Jenkinsfile 的鏡像映像相同', () => {
    expect(list).toEqual([
      ['ghcr.io/gitleaks/gitleaks:v8.30.1', 'gitleaks'],
      ['ghcr.io/google/osv-scanner:v2.7.1', 'osv-scanner'],
      ['docker.io/aquasec/trivy:0.76.2', 'trivy'],
      ['docker.io/semgrep/semgrep:1.185.0', 'semgrep'],
      ['docker.io/anchore/syft:v1.57.1', 'syft'],
      ['gcr.io/go-containerregistry/crane:v0.22.1', 'crane'],
      ['ghcr.io/sigstore/cosign/cosign:v2.6.5', 'cosign'],
      ['ghcr.io/zaproxy/zaproxy:2.17.0', 'zap'],
    ]);
    const jenkinsfile = read('Jenkinsfile');
    const mirrored = [...jenkinsfile.matchAll(/^\s*LM_[A-Z_]+_IMAGE = '[^']+\/mirror\/([a-z0-9._-]+)@sha256:[0-9a-f]{64}'$/gm)].map((m) => m[1]);
    expect(mirrored.sort()).toEqual(list.map(([, name]) => name).sort());
  });

  test('mirror.sh：bash 嚴格模式、umask 077、暫存 DOCKER_CONFIG 由 trap 刪除、密碼只經 stdin', () => {
    const s = read(`${DIR}/mirror.sh`);
    expect(s).not.toContain('\r');
    expect(s.split('\n')[0]).toBe('#!/usr/bin/env bash');
    const code = codeLines(s).join('\n');
    expect(code).toMatch(/^set -euo pipefail$/m);
    expect(code).toMatch(/^umask 077$/m);
    expect(code).toContain('d="$(mktemp -d)"');
    expect(code).toContain(`trap 'rm -rf "$d"' EXIT`);
    expect(code).toContain('export DOCKER_CONFIG="$d"');
    expect(code.indexOf('trap ')).toBeLessThan(code.indexOf('docker login'));
    expect(code).toContain('docker login -u lm-push --password-stdin "$LM_REGISTRY" < "$LM_PUSH_PASSWORD_FILE"');
    // 不讀出、不輸出密碼檔內容，也不開啟 xtrace。
    expect(code).not.toMatch(/cat\s+"?\$LM_PUSH_PASSWORD_FILE|\$\(<\s*"?\$LM_PUSH_PASSWORD_FILE|set -x|--password[ =]/);
  });

  test('mirror.sh：crane 容器以目前使用者執行、唯讀掛載登入資訊與 CA，不加 -i', () => {
    const code = codeLines(read(`${DIR}/mirror.sh`)).join('\n');
    const fn = /^crane\(\) \{\n([\s\S]*?)\n\}$/m.exec(code)?.[1];
    expect(fn).toBeTruthy();
    const run = fn.replace(/\\\n\s*/g, ' ');
    expect(run).toContain('docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e DOCKER_CONFIG=/cfg');
    expect(run).toContain('-v "$d:/cfg:ro"');
    expect(run).toContain('-v "$CA_BUNDLE:$CA_BUNDLE:ro"');
    expect(code).toContain('CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt');
    expect(code).toContain('CRANE_IMAGE=gcr.io/go-containerregistry/crane:v0.22.1');
    expect(run).not.toMatch(/\s(-i|-it|-ti|--interactive)\b/);
    expect(run).not.toMatch(/--privileged|--network[ =]host|docker\.sock/);
  });

  test('mirror.sh：linux/amd64 複製到 mirror/<名稱>:<tag>，輸出 digest 引用；失敗輸出 FAILED 並以非零結束', () => {
    const code = codeLines(read(`${DIR}/mirror.sh`)).join('\n');
    expect(code).toContain('done 3< "$list"');
    expect(code).toContain('tag="${src##*:}"');
    expect(code).toContain('dst="$LM_REGISTRY/little-moments/mirror/$name:$tag"');
    expect(code).toContain('crane copy --platform linux/amd64 "$src" "$dst" >&2');
    expect(code).toContain('digest="$(crane digest "$dst")"');
    expect(code).toContain("printf '%s\\n' \"$LM_REGISTRY/little-moments/mirror/$name@$digest\"");
    expect(code).toContain("printf 'FAILED %s\\n' \"$src\"");
    expect(code).toContain('trivy_db_src=mirror.gcr.io/aquasec/trivy-db:2');
    expect(code).toContain('trivy_db_dst="$LM_REGISTRY/little-moments/mirror/trivy-db:2"');
    expect(code).toMatch(/exit "\$rc"\s*$/);
  });
});

describe('lm-mirror-trivy-db（每日複製 trivy-db）', () => {
  test('POSIX sh、set -eu、暫存 DOCKER_CONFIG、crane 容器唯讀且無 capability', () => {
    const s = read(`${DIR}/lm-mirror-trivy-db`);
    expect(s).not.toContain('\r');
    expect(s.split('\n')[0]).toBe('#!/bin/sh');
    const code = codeLines(s).join('\n').replace(/\\\n\s*/g, ' ');
    expect(code).toMatch(/^set -eu$/m);
    expect(code).toContain('. /etc/lm-mirror-trivy-db.env');
    expect(code).toContain(`d=$(mktemp -d); trap 'rm -rf "$d"' EXIT`);
    expect(code).toContain('docker login -u lm-push --password-stdin "$REG" < "$PASS" > /dev/null');
    expect(code).toContain('docker run --rm --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true');
    expect(code).toContain('"$CRANE" copy mirror.gcr.io/aquasec/trivy-db:2 "$REG/little-moments/mirror/trivy-db:2"');
  });

  test('env 範本只含 REG、PASS、CRANE 的 PLACEHOLDER', () => {
    const vars = codeLines(read(`${DIR}/lm-mirror-trivy-db.env.example`)).map((l) => /^([A-Z_]+)='(.*)'$/.exec(l.trim()));
    expect(vars.every(Boolean)).toBe(true);
    expect(vars.map((m) => m[1])).toEqual(['REG', 'PASS', 'CRANE']);
    for (const m of vars) expect(m[2]).toMatch(/<[^>]+>/);
  });

  test('service 為 oneshot、在網路與 Docker 之後；timer 每日 04:30、隨機延後 30 分鐘、補做錯過的執行', () => {
    const svc = codeLines(read(`${DIR}/lm-mirror-trivy-db.service`)).map((l) => l.trim());
    for (const l of ['[Unit]', 'Wants=network-online.target', '[Service]', 'Type=oneshot', 'ExecStart=/usr/local/sbin/lm-mirror-trivy-db']) {
      expect(svc).toContain(l);
    }
    const after = svc.filter((l) => l.startsWith('After=')).flatMap((l) => l.slice(6).split(/\s+/));
    expect(after).toEqual(expect.arrayContaining(['network-online.target', 'docker.service']));
    const timer = codeLines(read(`${DIR}/lm-mirror-trivy-db.timer`)).map((l) => l.trim());
    for (const l of ['[Timer]', 'OnCalendar=*-*-* 04:30', 'RandomizedDelaySec=30m', 'Persistent=true', '[Install]', 'WantedBy=timers.target']) {
      expect(timer).toContain(l);
    }
  });
});

describe('deploy/registry/README.md（tasks 19.5）', () => {
  const buf = readFileSync(resolve(root, `${DIR}/README.md`));
  const readme = buf.toString('utf8');

  test('提到 deploy/registry 的每個檔案', () => {
    const files = readdirSync(resolve(root, DIR), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== 'README.md' && e.name !== '.env')
      .map((e) => e.name);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect({ file: f, mentioned: readme.includes(`\`${f}\``) }).toEqual({ file: f, mentioned: true });
  });

  test('UTF-8 無 BOM、LF；沒有 digest、長十六進位或 Base64 字串與秘密字面值', () => {
    expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf).toBe(false);
    expect(readme.includes('\r')).toBe(false);
    expect(readme).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(readme).not.toMatch(/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/);
    expect(readme).not.toMatch(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
    expect(readme).not.toMatch(/\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/);
    expect(readme.match(/[0-9a-f]{32,}/gi)).toBeNull();
    for (const m of readme.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) expect(m[0]).toMatch(/^[a-z/]+$/);
  });
});
