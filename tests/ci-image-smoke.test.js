// ci/scripts/image-smoke.sh（Rust 版 App_Image 的映像層級 Smoke 測試；plan.md D4、D15）的靜態檢查：
// 腳本需要 Docker，這裡只檢查隔離、清理、秘密處理，以及與 Dockerfile／Jenkinsfile 相符的映像設定。
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../ci/scripts/image-smoke.sh', import.meta.url), 'utf8');
const code = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
// 合併以 \ 續行的指令。
const joined = code.replace(/\\\n/g, ' ');
const dockerRuns = joined.split('\n').filter((l) => /"\$DOCKER_BIN" (run|create) /.test(l));

describe('ci/scripts/image-smoke.sh（靜態檢查）', () => {
  test('LF 換行、嚴格模式與 trap 清理', () => {
    expect(script).not.toContain('\r');
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(code).toContain('set -euo pipefail');
    expect(code).toMatch(/trap cleanup EXIT/);
    expect(code).toMatch(/rm -fv/);
    expect(code).toMatch(/network rm/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
  });

  test('參數與 Jenkinsfile 的呼叫相同；報告檔名不變', () => {
    expect(script).toContain('--image|--postgres-image|--runner-image|--reports|--label');
    for (const f of ['image-smoke-summary.json', 'image-smoke.json', 'image-smoke-app.log', 'image-smoke-migrate.log']) {
      expect(code).toContain(f);
    }
    // runner 預設為 Build_Image（App_Image 是 distroless，沒有 bun）。
    expect(code).toContain('runner_image="${BUILD_IMAGE:-}"');
  });

  test('只使用 --internal 網路且不發布任何連接埠，也不使用 bind mount 或具名卷', () => {
    expect(code).toContain('network create --internal');
    expect(dockerRuns.length).toBe(4); // 映像檔案容器、database、app、runner
    for (const cmd of dockerRuns) {
      expect(cmd).not.toMatch(/\s(-p|--publish|--publish-all|-P)[\s=]/);
      expect(cmd).toContain('--network "$net"');
      expect(cmd).toContain('"${labels[@]}"');
      expect(cmd).not.toMatch(/\s(-v|--volume|--mount)[\s=]/);
    }
    expect(code).not.toMatch(/--network[ =]host/);
    expect(code).toContain('--label "lm.ci.build=${label}"');
  });

  test('App 以映像的預設 ENTRYPOINT 與 USER 執行：唯讀、cap_drop ALL、no-new-privileges、埠 8080', () => {
    const app = dockerRuns.find((l) => l.includes('--name "$app"'));
    expect(app).toBeDefined();
    for (const s of ['"${hardening[@]}"', '--read-only', '--env-file "${env_dir}/app.env"', '-e "LM_BIND=0.0.0.0:${APP_PORT}"', '-e "SUPABASE_URL=http://127.0.0.1:9"']) {
      expect(app).toContain(s);
    }
    expect(app).not.toMatch(/--entrypoint|--user/);
    // 映像之後沒有指令參數（使用映像的 ENTRYPOINT）。
    expect(app).toMatch(/ "\$image" >\/dev\/null\s+\|\| die 7 /);
    expect(code).toContain('hardening=(--cap-drop ALL --security-opt no-new-privileges:true)');
    expect(code).toContain('readonly APP_PORT="8080"');
  });

  test('檢查 GET /robots.txt 200、GET / 200、GET /api/me 401，以及 /app/migrations 與 supabase/migrations 相同', () => {
    for (const s of ["'/robots.txt'", "'/'", "'/api/me'", 'res.status === 401', 'streak < 3']) expect(code).toContain(s);
    expect(code).toContain('"${files}:/app/migrations"');
    expect(code).toContain('repo_migrations=(supabase/migrations/*.sql)');
    expect(code).toMatch(/sha256sum < "\$f"/);
    // 不執行遷移：supabase/migrations 需要 Supabase 的 schema 與角色（plan.md D7）。
    expect(code).not.toMatch(/psql|migrate\.js/);
  });

  test('秘密只經由 --env-file 傳遞，不出現在 -e 參數或輸出', () => {
    for (const name of ['POSTGRES_PASSWORD', 'DATABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY']) {
      expect(code).not.toMatch(new RegExp(`-e\\s+"?${name}`));
    }
    expect(code).toContain('umask 077');
    expect(code).not.toMatch(/echo[^\n]*\$\{?db_password/);
  });

  test('Ephemeral_Database 映像以 digest 固定', () => {
    expect(code).toMatch(/@sha256:\[0-9a-f\]\{64\}/);
  });
});
