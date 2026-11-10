// 遷移檔 lint（Requirement 12.6、12.9；design.md Components §5「破壞性遷移偵測」、Property 31）。
//
//   bun scripts/lint-migrations.mjs [dir]     # 預設為 repository 的 migrations/
//
// 檢查項目：
//   1. 破壞性語句（DROP TABLE、DROP COLUMN、ALTER TABLE … DROP、ALTER TABLE … RENAME、DROP SCHEMA）
//      必須在檔頭標記 `-- lm:destructive`（Req 12.9）；標記後由 Pipeline 另行核准（Req 12.6）。
//   2. 無法在交易內執行的語句一律拒絕（Migration_Runner 以單一交易執行每個遷移）：
//      CONCURRENTLY、VACUUM、ALTER SYSTEM、CREATE/DROP DATABASE、CREATE/DROP TABLESPACE、
//      交易控制語句（BEGIN、COMMIT、ROLLBACK…）等。
//   3. 無法完整解析（未結束的字串、註解或引號識別字）視為失敗（fail closed）。
//
// 偵測前先以 PostgreSQL 詞法規則移除註解（`--`、可巢狀的 `/* */`）與字串常值
// （`'…'` 含 `''`、E'…' 含反斜線跳脫、`$$…$$`、`$tag$…$tag$`），雙引號識別字視為一般識別字而非關鍵字。
// 關鍵字比對不分大小寫，且容許任意空白與換行。
//
// 結束碼：0 全部通過；1 至少一個檔案未通過（列出檔名）；3 遷移集合無效；2 無法讀取目錄。
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDestructiveMarker, loadMigrations, MigrationValidationError, DESTRUCTIVE_MARKER } from '../server/db/migrations.js';

export const EXIT_LINT_OK = 0;
export const EXIT_LINT_FAILED = 1;
export const EXIT_LINT_IO = 2;
export const EXIT_LINT_INVALID_SET = 3;

/** 破壞性語句類別。 */
export const DESTRUCTIVE_KINDS = Object.freeze(['drop_table', 'drop_column', 'alter_table_drop', 'alter_table_rename', 'drop_schema']);

// ---------------------------------------------------------------------------
// 詞法分析
// ---------------------------------------------------------------------------

const isIdentStart = ch => /[A-Za-z_\u0080-\uFFFF]/.test(ch);
const isIdentChar = ch => /[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch);

/**
 * 將 SQL 切成 token；註解與字串常值不產生 token。
 * @returns {{tokens:{type:'word'|'ident'|'punct'|'other', value:string, line:number}[], errors:{line:number, reason:string}[]}}
 *   word：未加引號的識別字或關鍵字（value 已轉大寫）；ident：雙引號識別字（永不視為關鍵字）。
 */
export function tokenize(sql) {
  if (typeof sql !== 'string') throw new TypeError('sql 必須是字串');
  const src = sql.replace(/^\uFEFF/, '');
  const tokens = [];
  const errors = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  const advanceTo = end => {
    for (let k = i; k < end && k < n; k++) if (src[k] === '\n') line++;
    i = Math.min(end, n);
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }

    // -- 行註解
    if (ch === '-' && next === '-') {
      const end = src.indexOf('\n', i);
      advanceTo(end === -1 ? n : end);
      continue;
    }

    // /* */ 區塊註解（可巢狀）
    if (ch === '/' && next === '*') {
      const startLine = line;
      let depth = 0;
      let k = i;
      while (k < n) {
        if (src[k] === '/' && src[k + 1] === '*') { depth++; k += 2; continue; }
        if (src[k] === '*' && src[k + 1] === '/') { depth--; k += 2; if (depth === 0) break; continue; }
        k++;
      }
      if (depth !== 0) errors.push({ line: startLine, reason: '區塊註解未結束' });
      advanceTo(k);
      continue;
    }

    // E'…'（反斜線跳脫）
    if ((ch === 'E' || ch === 'e') && next === "'" && !(i > 0 && isIdentChar(src[i - 1]))) {
      const startLine = line;
      let k = i + 2;
      let closed = false;
      while (k < n) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === "'") {
          if (src[k + 1] === "'") { k += 2; continue; }
          closed = true; k++; break;
        }
        k++;
      }
      if (!closed) errors.push({ line: startLine, reason: '字串常值未結束' });
      advanceTo(k);
      continue;
    }

    // '…'（'' 跳脫；standard_conforming_strings 下反斜線不是跳脫字元）
    if (ch === "'") {
      const startLine = line;
      let k = i + 1;
      let closed = false;
      while (k < n) {
        if (src[k] === "'") {
          if (src[k + 1] === "'") { k += 2; continue; }
          closed = true; k++; break;
        }
        k++;
      }
      if (!closed) errors.push({ line: startLine, reason: '字串常值未結束' });
      advanceTo(k);
      continue;
    }

    // "…" 雙引號識別字（"" 跳脫）
    if (ch === '"') {
      const startLine = line;
      let k = i + 1;
      let closed = false;
      let value = '';
      while (k < n) {
        if (src[k] === '"') {
          if (src[k + 1] === '"') { value += '"'; k += 2; continue; }
          closed = true; k++; break;
        }
        value += src[k];
        k++;
      }
      if (!closed) errors.push({ line: startLine, reason: '雙引號識別字未結束' });
      tokens.push({ type: 'ident', value, line: startLine });
      advanceTo(k);
      continue;
    }

    // $$…$$ 或 $tag$…$tag$（前一字元不得為識別字字元，例如 a$b$ 是識別字的一部分）
    if (ch === '$' && !(i > 0 && isIdentChar(src[i - 1]))) {
      const m = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(src.slice(i, i + 256));
      if (m) {
        const tag = m[0];
        const startLine = line;
        const end = src.indexOf(tag, i + tag.length);
        if (end === -1) {
          errors.push({ line: startLine, reason: '錢號引號字串未結束' });
          advanceTo(n);
        } else {
          advanceTo(end + tag.length);
        }
        continue;
      }
    }

    // 未加引號的識別字／關鍵字
    if (isIdentStart(ch)) {
      let k = i + 1;
      while (k < n && isIdentChar(src[k])) k++;
      tokens.push({ type: 'word', value: src.slice(i, k).toUpperCase(), line });
      i = k;
      continue;
    }

    // 數字與位置參數（$1）視為 other
    if (/[0-9]/.test(ch) || ch === '$') {
      let k = i + 1;
      while (k < n && /[0-9A-Za-z_.]/.test(src[k])) k++;
      tokens.push({ type: 'other', value: src.slice(i, k), line });
      i = k;
      continue;
    }

    if (';,().*'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line });
      i++;
      continue;
    }

    tokens.push({ type: 'other', value: ch, line });
    i++;
  }

  return { tokens, errors };
}

/** 以頂層 `;` 切分語句，回傳非空語句的 token 陣列。 */
export function splitStatements(tokens) {
  const statements = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';') {
      if (current.length) statements.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length) statements.push(current);
  return statements;
}

// ---------------------------------------------------------------------------
// 語句分析
// ---------------------------------------------------------------------------

const isWord = (t, value) => t && t.type === 'word' && t.value === value;
const isPunct = (t, value) => t && t.type === 'punct' && t.value === value;
const isName = t => t && (t.type === 'word' || t.type === 'ident');

/** 解析 ALTER TABLE 的動作清單，回傳每個頂層動作的 token 陣列。非 ALTER TABLE 回傳 null。 */
function alterTableActions(stmt) {
  if (!(isWord(stmt[0], 'ALTER') && isWord(stmt[1], 'TABLE'))) return null;
  let i = 2;
  if (isWord(stmt[i], 'IF') && isWord(stmt[i + 1], 'EXISTS')) i += 2;
  if (isWord(stmt[i], 'ONLY')) i++;
  if (!isName(stmt[i])) return [];
  i++;
  while (isPunct(stmt[i], '.') && isName(stmt[i + 1])) i += 2;
  if (isPunct(stmt[i], '*')) i++;

  const actions = [];
  let current = [];
  let depth = 0;
  for (; i < stmt.length; i++) {
    const t = stmt[i];
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth = Math.max(0, depth - 1);
    if (depth === 0 && isPunct(t, ',')) {
      if (current.length) actions.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length) actions.push(current);
  return actions;
}

function destructiveFindings(stmt) {
  const found = [];
  const add = (kind, token) => {
    if (!found.some(f => f.kind === kind)) found.push({ kind, line: token.line });
  };

  const actions = alterTableActions(stmt);
  if (actions) {
    for (const action of actions) {
      const head = action[0];
      if (isWord(head, 'RENAME')) add('alter_table_rename', head);
      else if (isWord(head, 'DROP')) add(isWord(action[1], 'COLUMN') ? 'drop_column' : 'alter_table_drop', head);
    }
  }

  // 任意位置的 DROP TABLE／DROP COLUMN／DROP SCHEMA（引號識別字不會被當作關鍵字）。
  for (let i = 0; i + 1 < stmt.length; i++) {
    if (!isWord(stmt[i], 'DROP')) continue;
    const kw = stmt[i + 1];
    if (isWord(kw, 'TABLE')) add('drop_table', stmt[i]);
    else if (isWord(kw, 'COLUMN')) add('drop_column', stmt[i]);
    else if (isWord(kw, 'SCHEMA')) add('drop_schema', stmt[i]);
  }
  return found;
}

const TX_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'ABORT', 'SAVEPOINT', 'RELEASE', 'PREPARE']);

function nonTransactionalFindings(stmt) {
  const found = [];
  const [a, b] = stmt;
  const add = (statement, token) => found.push({ statement, line: token.line });

  if (stmt.some(t => isWord(t, 'CONCURRENTLY'))) {
    const head = stmt.slice(0, 2).filter(t => t.type === 'word' && t.value !== 'CONCURRENTLY').map(t => t.value).join(' ');
    // REFRESH MATERIALIZED VIEW CONCURRENTLY 可在交易內執行，其他 CONCURRENTLY 一律拒絕。
    if (!(isWord(a, 'REFRESH') && isWord(b, 'MATERIALIZED'))) add(`${head} … CONCURRENTLY`, stmt.find(t => isWord(t, 'CONCURRENTLY')));
  }
  if (isWord(a, 'VACUUM')) add('VACUUM', a);
  if (isWord(a, 'ALTER') && isWord(b, 'SYSTEM')) add('ALTER SYSTEM', a);
  if ((isWord(a, 'CREATE') || isWord(a, 'DROP')) && (isWord(b, 'DATABASE') || isWord(b, 'TABLESPACE'))) add(`${a.value} ${b.value}`, a);
  if (isWord(a, 'REINDEX') && (isWord(b, 'DATABASE') || isWord(b, 'SYSTEM'))) add(`REINDEX ${b.value}`, a);
  if ((isWord(a, 'CREATE') || isWord(a, 'DROP')) && isWord(b, 'SUBSCRIPTION')) add(`${a.value} SUBSCRIPTION`, a);
  if (isWord(a, 'DISCARD') && isWord(b, 'ALL')) add('DISCARD ALL', a);
  if (isWord(a, 'START') && isWord(b, 'TRANSACTION')) add('START TRANSACTION', a);
  if (isWord(a, 'COMMIT') || isWord(a, 'ROLLBACK')) {
    add(isWord(b, 'PREPARED') ? `${a.value} PREPARED` : a.value, a);
  } else if (a && a.type === 'word' && TX_CONTROL.has(a.value)) {
    // PREPARE 僅在 PREPARE TRANSACTION 時屬交易控制；PREPARE name AS … 是一般語句。
    if (a.value !== 'PREPARE' || isWord(b, 'TRANSACTION')) add(a.value === 'PREPARE' ? 'PREPARE TRANSACTION' : a.value, a);
  }
  return found;
}

/**
 * 分析 SQL 文字。
 * @returns {{destructive:{kind:string, line:number}[], nonTransactional:{statement:string, line:number}[],
 *   errors:{line:number, reason:string}[]}}
 */
export function analyzeSql(sql) {
  const { tokens, errors } = tokenize(sql);
  const destructive = [];
  const nonTransactional = [];
  for (const stmt of splitStatements(tokens)) {
    destructive.push(...destructiveFindings(stmt));
    nonTransactional.push(...nonTransactionalFindings(stmt));
  }
  return { destructive, nonTransactional, errors };
}

/** 回傳註解與字串常值以外的破壞性語句清單（每筆含類別與行號）。 */
export function findDestructiveStatements(sql) {
  return analyzeSql(sql).destructive;
}

/** Property 31：註解與字串常值以外存在破壞性語句時為 true。 */
export function detectDestructive(sql) {
  return findDestructiveStatements(sql).length > 0;
}

/**
 * Lint 單一遷移。
 * @param {{name:string, sql:string}} migration
 * @returns {{name:string, ok:boolean, marked:boolean, destructive:object[], nonTransactional:object[],
 *   errors:object[], problems:string[]}}
 */
export function lintMigration({ name, sql }) {
  const { destructive, nonTransactional, errors } = analyzeSql(sql);
  const marked = hasDestructiveMarker(sql);
  const problems = [];
  for (const e of errors) problems.push(`第 ${e.line} 行：${e.reason}`);
  for (const f of nonTransactional) problems.push(`第 ${f.line} 行：${f.statement} 無法在交易內執行`);
  if (destructive.length && !marked) {
    const kinds = destructive.map(f => `${f.kind}@${f.line}`).join(', ');
    problems.push(`偵測到破壞性語句（${kinds}）但檔頭缺少 \`${DESTRUCTIVE_MARKER}\``);
  }
  return { name, ok: problems.length === 0, marked, destructive, nonTransactional, errors, problems };
}

/** Lint 一組遷移檔（[{name, content}]）。遷移集合無效時拋出 MigrationValidationError。 */
export function lintMigrationFiles(files) {
  const migrations = loadMigrations(files);
  const results = migrations.map(m => lintMigration({ name: m.name, sql: m.sql }));
  return { ok: results.every(r => r.ok), results, failed: results.filter(r => !r.ok).map(r => r.name) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function readMigrationFiles(dir) {
  const names = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({ name, content: new Uint8Array(await readFile(join(dir, name))) })));
}

export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const dir = argv[0] ? resolve(argv[0]) : fileURLToPath(new URL('../migrations/', import.meta.url));
  let files;
  try {
    files = await readMigrationFiles(dir);
  } catch (e) {
    err(`無法讀取遷移目錄 ${dir}：${e?.code || e?.name || 'Error'}`);
    return EXIT_LINT_IO;
  }

  let report;
  try {
    report = lintMigrationFiles(files);
  } catch (e) {
    if (e instanceof MigrationValidationError) {
      err(e.message);
      return EXIT_LINT_INVALID_SET;
    }
    throw e;
  }

  for (const r of report.results) {
    const tag = r.destructive.length ? (r.marked ? ' [destructive]' : '') : '';
    if (r.ok) out(`ok   ${r.name}${tag}`);
    else {
      err(`FAIL ${r.name}`);
      for (const p of r.problems) err(`     ${p}`);
    }
  }
  if (!report.ok) {
    err(`lint-migrations 未通過：${report.failed.join(', ')}`);
    return EXIT_LINT_FAILED;
  }
  out(`lint-migrations 通過：${report.results.length} 個遷移檔`);
  return EXIT_LINT_OK;
}

if (import.meta.main) process.exit(await main());
