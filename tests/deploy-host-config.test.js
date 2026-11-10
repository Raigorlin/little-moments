// deploy/host 主機安全設定的靜態檢查（Requirements 8.6、11.10、14.4、15.9；design.md Components §12）。
// 這些檔案只在 Deploy_Host 上以 root 生效；此處確認提交內容維持最小權限與 fail-closed 的關鍵性質。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = join(import.meta.dir, '..', 'deploy', 'host');
const read = name => readFileSync(join(HOST, name), 'utf8');
const body = text => text.split('\n').filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'));

const FILES = [
  'docker-user.rules',
  'lm-docker-user.service',
  'sudoers.d/lm-deploy',
  'authorized_keys.tmpl',
  'install.sh',
  'verify-host.sh',
];

describe('deploy/host', () => {
  test('所有檔案以 LF 結尾、不含 CR（sudoers／iptables／bash 會拒絕或誤判 CR）', () => {
    for (const f of FILES) expect(read(f).includes('\r')).toBe(false);
  });

  test('sudoers：每個部署帳號只能執行自己環境的固定 lm-deploy 指令列', () => {
    const lines = body(read('sudoers.d/lm-deploy'));
    const specs = lines.filter(l => !/^(Defaults|User_Alias|Cmnd_Alias)\b/.test(l));
    expect(specs).toEqual([
      'LM_DEPLOY_STAGING_USERS ALL = (root) NOPASSWD: LM_DEPLOY_STAGING_CMD',
      'LM_DEPLOY_PROD_USERS ALL = (root) NOPASSWD: LM_DEPLOY_PROD_CMD',
    ]);
    expect(lines).toContain('User_Alias LM_DEPLOY_STAGING_USERS = lm-deploy-staging');
    expect(lines).toContain('User_Alias LM_DEPLOY_PROD_USERS = lm-deploy-prod');
    expect(lines).toContain('Cmnd_Alias LM_DEPLOY_STAGING_CMD = /opt/lm/bin/lm-deploy staging');
    expect(lines).toContain('Cmnd_Alias LM_DEPLOY_PROD_CMD = /opt/lm/bin/lm-deploy prod');
    // SSH_ORIGINAL_COMMAND 只對 lm-deploy 保留；不得有全域 env_keep、SETENV 或萬用指令。
    const envKeep = lines.filter(l => l.includes('env_keep'));
    expect(envKeep).toEqual(['Defaults!/opt/lm/bin/lm-deploy env_keep += "SSH_ORIGINAL_COMMAND"']);
    for (const l of lines) {
      expect(l).not.toMatch(/SETENV|!env_reset|\*|NOPASSWD:\s*ALL/);
    }
  });

  test('authorized_keys 樣板：forced command、from=、no-pty 與 restrict', () => {
    const [line, ...rest] = body(read('authorized_keys.tmpl'));
    expect(rest).toEqual([]);
    expect(line.startsWith('restrict,')).toBe(true);
    expect(line).toContain('command="/usr/bin/sudo -n /opt/lm/bin/lm-deploy __ENV__"');
    expect(line).toContain('from="__AGENT_FROM__"');
    // 選項欄位（含引號內的空白）到公鑰之前結束。
    const options = line.slice(0, line.lastIndexOf(' __PUBKEY__')).replace(/"[^"]*"/g, '""').split(',');
    for (const opt of ['no-pty', 'no-port-forwarding', 'no-agent-forwarding', 'no-X11-forwarding', 'no-user-rc']) {
      expect(options).toContain(opt);
    }
    expect(line.endsWith(' __PUBKEY__')).toBe(true);
  });

  test('DOCKER-USER 規則：只放行 LAN 網段的 DNAT 連線，其餘 DNAT 一律 DROP', () => {
    const rules = body(read('docker-user.rules'));
    expect(rules).toEqual([
      '*filter',
      ':DOCKER-USER - [0:0]',
      '-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A DOCKER-USER -s __LAN_CIDR__ -m conntrack --ctstate DNAT -j RETURN',
      '-A DOCKER-USER -m conntrack --ctstate DNAT -j DROP',
      '-A DOCKER-USER -j RETURN',
      'COMMIT',
    ]);
    expect(rules.some(l => / -j ACCEPT\b/.test(l))).toBe(false);
  });

  test('systemd unit：在 docker.service 之前套用，且不以 Requires= 連帶重啟 Docker', () => {
    const unit = read('lm-docker-user.service');
    expect(unit).toMatch(/^Before=.*\bdocker\.service\b/m);
    expect(unit).toMatch(/^WantedBy=.*\bdocker\.service\b/m);
    expect(unit).not.toMatch(/^(Requires|BindsTo|PartOf)=/m);
    expect(unit).not.toMatch(/^Condition/m);
    expect(unit).toMatch(/^ExecStart=\/usr\/sbin\/iptables-restore .*--noflush \/etc\/lm\/docker-user\.rules$/m);
    expect(unit).not.toMatch(/^ExecStop=/m);
  });

  test('install.sh：驗證後才安裝 sudoers／規則，備份目錄為 lm-ops 0700', () => {
    const sh = read('install.sh');
    expect(sh).toMatch(/^set -euo pipefail$/m);
    expect(sh).toContain('visudo -cf "$tmp"');
    expect(sh).toContain('iptables-restore --test --noflush "$tmp"');
    expect(sh).toContain('install -d -o "$OPS_USER" -g "$OPS_USER" -m 0700 -- "$BACKUP_ROOT"');
    expect(sh).toContain('readonly BACKUP_ROOT=/var/backups/little-moments');
    expect(sh).toContain('install_atomic "$SRC_LM_DEPLOY" "$LM_BIN" 0755');
    // 不得把佔位密碼範本複製成實際秘密檔。
    expect(sh).not.toMatch(/(app|db)\.env\.example" "\$d\//);
  });

  test('verify-host.sh：涵蓋規則、備份目錄、db 連接埠與 docker 群組檢查', () => {
    const sh = read('verify-host.sh');
    expect(sh).toMatch(/^set -euo pipefail$/m);
    for (const fn of ['check_firewall', 'check_db', 'check_backup', 'check_account', 'check_files']) {
      expect(sh).toContain(`${fn}() {`);
    }
    expect(sh).toContain('iptables -w 5 -C DOCKER-USER');
    expect(sh).toContain('.HostConfig.PortBindings');
    expect(sh).toContain('sudo -n -l -U "$user"');
    // 唯讀：不得呼叫會修改主機狀態的指令。
    for (const cmd of ['iptables-restore', 'usermod', 'gpasswd', 'chmod ', 'chown ', 'systemctl reload', 'systemctl restart', 'docker rm', 'rm -']) {
      expect(body(sh).some(l => l.includes(cmd) && !/^\s*(fail|pass|warn) /.test(l))).toBe(false);
    }
  });
});
