// Release_Approver 檢查（Requirement 12.6、19.3、20.10；Design §5、Property 32）。
//
// 純函式：
//   loadApprovers(doc)                                   → { ok:true, approvers } | { ok:false, reason }
//   isReleaseApprover(id, approvers)                     → boolean
//   destructiveApprovalAllowed(approver, approvers, authors) → { allowed:boolean, reason:string }
//
// `approvers` 可為 ci/release-approvers.json 的完整文件，或其 approvers 陣列。
// 任何格式問題一律拒絕（fail closed）。
//
// CLI（供 Jenkinsfile 使用）：
//   bun ci/approval.mjs release     --approver <id> [--file <path>]
//   bun ci/approval.mjs destructive --approver <id> --migration migrations/NNNN_x.sql [--file <path>]
//   結束碼：0 允許；1 拒絕；2 用法錯誤。輸出一行 JSON：{ allowed, reason, ... }。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APPROVERS_FILE = join(HERE, 'release-approvers.json');
export const MIGRATION_PATH_RE = /^migrations\/\d{4,}_[a-z0-9_]+\.sql$/;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** 正規化 email：去除前後空白並轉小寫；格式無效回傳 null。 */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * 驗證並正規化核准人清單。jenkinsId 重複、缺少 email 或 email 無效皆使整份清單無效。
 * @returns {{ok:true, approvers:{jenkinsId:string, emails:string[]}[]} | {ok:false, reason:string}}
 */
export function loadApprovers(doc) {
  const list = Array.isArray(doc) ? doc : doc?.approvers;
  if (!Array.isArray(list)) return { ok: false, reason: 'approvers 清單格式無效' };
  const seen = new Set();
  const approvers = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !isValidId(entry.jenkinsId)) {
      return { ok: false, reason: 'approvers 項目缺少有效 jenkinsId' };
    }
    if (seen.has(entry.jenkinsId)) return { ok: false, reason: `jenkinsId 重複：${entry.jenkinsId}` };
    seen.add(entry.jenkinsId);
    if (!Array.isArray(entry.emails) || entry.emails.length === 0) {
      return { ok: false, reason: `jenkinsId ${entry.jenkinsId} 缺少 email 對照` };
    }
    const emails = entry.emails.map(normalizeEmail);
    if (emails.some(e => e === null)) return { ok: false, reason: `jenkinsId ${entry.jenkinsId} 含無效 email` };
    approvers.push({ jenkinsId: entry.jenkinsId, emails: [...new Set(emails)] });
  }
  return { ok: true, approvers };
}

function findApprover(id, approvers) {
  if (!isValidId(id)) return { ok: false, reason: '核准人 ID 格式無效' };
  const loaded = loadApprovers(approvers);
  if (!loaded.ok) return loaded;
  const entry = loaded.approvers.find(a => a.jenkinsId === id);
  if (!entry) return { ok: false, reason: `${id} 不是 Release_Approver` };
  return { ok: true, entry };
}

/** 帳號是否為 Release_Approver（Jenkins ID 完全相符）。清單無效時回傳 false。 */
export function isReleaseApprover(id, approvers) {
  return findApprover(id, approvers).ok;
}

/**
 * 破壞性遷移核准判定：核准人須為 Release_Approver，且其任何對照 email 皆不在遷移作者集合內。
 * 作者集合為空或含無效 email 時拒絕。
 * @param {string} approver Jenkins ID
 * @param {unknown} approvers 核准人清單
 * @param {string[]} authors `git log --format=%ae -- <migration>` 的作者 email
 * @returns {{allowed:boolean, reason:string}}
 */
export function destructiveApprovalAllowed(approver, approvers, authors) {
  const found = findApprover(approver, approvers);
  if (!found.ok) return { allowed: false, reason: found.reason };
  if (!Array.isArray(authors) || authors.length === 0) {
    return { allowed: false, reason: '無法取得遷移作者' };
  }
  const authorSet = new Set();
  for (const a of authors) {
    const email = normalizeEmail(a);
    if (email === null) return { allowed: false, reason: '遷移作者 email 格式無效' };
    authorSet.add(email);
  }
  if (found.entry.emails.some(e => authorSet.has(e))) {
    return { allowed: false, reason: `${approver} 是該遷移的作者，不得核准` };
  }
  return { allowed: true, reason: `${approver} 為 Release_Approver 且非遷移作者` };
}

/**
 * 以陣列參數（不經 shell）取得遷移檔的作者 email。
 * @returns {{ok:true, authors:string[]} | {ok:false, reason:string}}
 */
export function migrationAuthors(migration, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  if (typeof migration !== 'string' || !MIGRATION_PATH_RE.test(migration)) {
    return { ok: false, reason: '遷移路徑格式無效' };
  }
  const result = spawn('git', ['log', '--format=%ae', '--', migration], {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, reason: `無法執行 git：${result.error.code ?? 'unknown'}` };
  if (result.status !== 0) return { ok: false, reason: `git log 失敗（結束碼 ${result.status}）` };
  const authors = String(result.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { ok: true, authors };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'release' && command !== 'destructive') return null;
  const opts = { command, approver: null, migration: null, file: DEFAULT_APPROVERS_FILE };
  const flags = { '--approver': 'approver', '--migration': 'migration', '--file': 'file' };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || i + 1 >= rest.length) return null;
    opts[key] = rest[++i];
  }
  if (!opts.approver) return null;
  if (command === 'destructive' && !MIGRATION_PATH_RE.test(opts.migration ?? '')) return null;
  if (command === 'release' && opts.migration !== null) return null;
  return opts;
}

const USAGE = '用法：bun ci/approval.mjs release --approver <id> [--file <path>]\n'
  + '      bun ci/approval.mjs destructive --approver <id> --migration migrations/NNNN_name.sql [--file <path>]';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = readFileSync, ...opts } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }
  const out = (decision, extra = {}) => {
    const line = JSON.stringify({ command: args.command, approver: args.approver, ...extra, ...decision });
    (decision.allowed ? log : error)(line);
    return decision.allowed ? 0 : 1;
  };

  let doc;
  try {
    doc = JSON.parse(readFile(args.file, 'utf8'));
  } catch {
    return out({ allowed: false, reason: '無法讀取核准人清單' });
  }

  if (args.command === 'release') {
    const found = findApprover(args.approver, doc);
    return out(found.ok
      ? { allowed: true, reason: `${args.approver} 為 Release_Approver` }
      : { allowed: false, reason: found.reason });
  }

  const authors = migrationAuthors(args.migration, opts);
  if (!authors.ok) return out({ allowed: false, reason: authors.reason }, { migration: args.migration });
  return out(destructiveApprovalAllowed(args.approver, doc, authors.authors), { migration: args.migration });
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
