// 備份與映像保留策略（Req 14.5、14.7、20.7、20.10；Design Property 37、41）。
//
// 純函式：
//   pruneBackups(existing, newBackup, verified, keep = 14) → { keep: Backup[], delete: Backup[] }
//   retainImages(history, keep = 3)                       → { retained: string[], removed: string[] }
//   rollbackAllowed(digest, retained)                     → boolean
//
// Backup 形狀：{ id: string, createdAt: string(ISO 8601) | number(epoch ms), ... }，其他欄位原樣保留。
// history 形狀：由舊到新排列的成功完成觀察期紀錄，項目為 digest 字串或 { digest, ... }（state/active.json 的 history）。
//
// CLI（供 deploy/bin/lm-deploy 與 Jenkinsfile 使用；輸入為 JSON 檔案路徑或 stdin）：
//   bun ci/retention.mjs prune-backups [--keep 14] [--unverified] [input.json]
//     input：{ "existing": Backup[], "newBackup": Backup }；輸出 { keep, delete }
//   bun ci/retention.mjs retain-images [--keep 3] [input.json]
//     input：history 陣列或 { "history": [...] }；輸出 { retained, removed }
//   bun ci/retention.mjs rollback-allowed --digest <sha256:…> [--keep 3] [input.json]
//     input 同 retain-images；結束碼 0 允許、1 拒絕
//   結束碼：0 成功／允許；1 拒絕；2 參數或輸入錯誤。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function assertKeep(keep) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new TypeError('keep 必須是正整數');
}

function createdMs(backup) {
  const v = backup?.createdAt;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`備份 ${backup?.id ?? '(無 id)'} 的 createdAt 無效`);
  return ms;
}

function assertBackup(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string' || b.id === '') {
    throw new TypeError('備份必須包含非空字串 id');
  }
  createdMs(b);
}

/** 由新到舊排序；建立時間相同時以 id 字典序（遞減）決定，結果具決定性。 */
function newestFirst(a, b) {
  const d = createdMs(b) - createdMs(a);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 備份修剪：
 * - 新備份未通過驗證 → 不刪除任何既有備份（Req 14.5、14.7），keep 為既有清單（新備份不納入）。
 * - 通過驗證 → 保留新備份與依建立時間最新的 keep-1 份既有備份，其餘（最舊者）列入 delete。新備份永不被刪除。
 */
export function pruneBackups(existing, newBackup, verified, keep = 14) {
  assertKeep(keep);
  if (!Array.isArray(existing)) throw new TypeError('existing 必須是陣列');
  existing.forEach(assertBackup);
  const ids = new Set();
  for (const b of existing) {
    if (ids.has(b.id)) throw new TypeError(`重複的備份 id：${b.id}`);
    ids.add(b.id);
  }
  if (verified !== true) return { keep: [...existing].sort(newestFirst), delete: [] };
  assertBackup(newBackup);
  const others = existing.filter((b) => b.id !== newBackup.id).sort(newestFirst);
  const kept = others.slice(0, keep - 1);
  const removed = others.slice(keep - 1);
  return { keep: [newBackup, ...kept].sort(newestFirst), delete: removed };
}

function digestOf(entry) {
  const d = typeof entry === 'string' ? entry : entry?.digest;
  if (typeof d !== 'string' || d === '') throw new TypeError('history 項目缺少 digest');
  return d;
}

/**
 * 可回滾映像保留：history 由舊到新，最後一筆為目前 Production 版本。
 * 保留最新 keep 個相異 digest（同一 digest 以最後出現的位置計算），removed 為其餘相異 digest（由新到舊）。
 */
export function retainImages(history, keep = 3) {
  assertKeep(keep);
  if (!Array.isArray(history)) throw new TypeError('history 必須是陣列');
  const order = [];
  const seen = new Set();
  for (let i = history.length - 1; i >= 0; i--) {
    const d = digestOf(history[i]);
    if (!seen.has(d)) { seen.add(d); order.push(d); }
  }
  return { retained: order.slice(0, keep), removed: order.slice(keep) };
}

/** 手動回滾目標必須與保留集合中某 digest 完全相同（Req 20.10）。retained 可為陣列或 retainImages 的結果。 */
export function rollbackAllowed(digest, retained) {
  const list = Array.isArray(retained) ? retained : Array.isArray(retained?.retained) ? retained.retained : null;
  if (!list || typeof digest !== 'string' || digest === '') return false;
  return list.some((d) => typeof d === 'string' && d === digest);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, keep: undefined, digest: null, verified: true, file: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--keep' || a === '--digest') {
      if (i + 1 >= rest.length) return null;
      opts[a.slice(2)] = rest[++i];
    } else if (a === '--unverified') opts.verified = false;
    else if (!opts.file) opts.file = a;
    else return null;
  }
  if (opts.keep !== undefined) {
    if (!/^\d+$/.test(opts.keep)) return null;
    opts.keep = Number(opts.keep);
  }
  return opts;
}

const USAGE = '用法：bun ci/retention.mjs prune-backups [--keep 14] [--unverified] [input.json] | '
  + 'retain-images [--keep 3] [input.json] | rollback-allowed --digest <digest> [--keep 3] [input.json]';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readInput } = {}) {
  const opts = parseArgs(argv);
  if (!opts || !['prune-backups', 'retain-images', 'rollback-allowed'].includes(opts.cmd)
    || (opts.cmd === 'rollback-allowed' && !opts.digest)) {
    error(USAGE);
    return 2;
  }
  let input;
  try {
    const text = readInput ? readInput(opts.file) : readFileSync(opts.file ?? 0, 'utf8');
    input = JSON.parse(text);
  } catch {
    error('無法讀取或解析輸入 JSON');
    return 2;
  }
  try {
    if (opts.cmd === 'prune-backups') {
      const result = pruneBackups(input?.existing, input?.newBackup, opts.verified, opts.keep ?? 14);
      log(JSON.stringify(result));
      return 0;
    }
    const history = Array.isArray(input) ? input : input?.history;
    const result = retainImages(history, opts.keep ?? 3);
    if (opts.cmd === 'retain-images') {
      log(JSON.stringify(result));
      return 0;
    }
    const allowed = rollbackAllowed(opts.digest, result);
    log(JSON.stringify({ digest: opts.digest, allowed, retained: result.retained }));
    if (!allowed) error('回滾目標不在 Deploy_Host 保留的可回滾 Image_Digest 中');
    return allowed ? 0 : 1;
  } catch (e) {
    error(`輸入無效：${e.message}`);
    return 2;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
