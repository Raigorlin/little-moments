// semgrep --test 範例：lm-child-process-exec-dynamic、lm-child-process-shell-option
// （不是可執行程式碼，僅供規則測試）。
import { exec, execSync, spawn, spawnSync, execFileSync } from 'node:child_process';
import * as cp from 'child_process';

const legacy = require('child_process');

function bad(branch, file, userCmd) {
  // ruleid: lm-child-process-exec-dynamic
  exec(`git log ${branch}`);
  // ruleid: lm-child-process-exec-dynamic
  execSync('cat ' + file, { encoding: 'utf8' });
  // ruleid: lm-child-process-exec-dynamic
  cp.exec(userCmd, () => {});
  // ruleid: lm-child-process-exec-dynamic
  legacy.execSync(userCmd);
  // ruleid: lm-child-process-shell-option
  spawn('git', ['log', branch], { cwd: '.', shell: true });
  // ruleid: lm-child-process-shell-option
  spawnSync(userCmd, { shell: '/bin/sh' });
  // ruleid: lm-child-process-shell-option
  cp.execFileSync('git', ['show', file], { shell: process.env.SHELL });
}

function good(bun, sha, ref, re, text) {
  // ok: lm-child-process-exec-dynamic
  exec('git status --porcelain');
  // ok: lm-child-process-shell-option
  spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8', shell: false });
  // ok: lm-child-process-shell-option
  spawn(bun, ['scripts/serve.mjs'], { cwd: '.', stdio: ['ignore', 'pipe', 'pipe'] });
  // ok: lm-child-process-shell-option
  execFileSync('crane', ['digest', ref], { timeout: 60_000 });
  // ok: lm-child-process-exec-dynamic
  const m = re.exec(text);
  return m;
}

export { bad, good };
