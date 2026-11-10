// QA_Inventory 驗證與測試結果比對（Requirement 5.1、5.2、5.4、5.5、5.7、5.8；Design Property 6、7）。
//
// 純函式：
//   validateInventory(doc)               → { ok, errors: [{ id: string|null, reason }] }
//   extractResults(playwrightReport)     → [{ testCase, viewport, outcome }]
//   compareInventory(inventory, results) → { ok, items: InventoryResult[], failed: string[], missing: string[] }
//
// CLI：
//   bun scripts/qa-inventory.mjs validate [qa/inventory.json]
//   bun scripts/qa-inventory.mjs compare  [qa/inventory.json] [reports/e2e.json] [--out reports/qa-inventory.json]
//   結束碼：0 通過；1 inventory 不合格、或有項目為 fail／missing；2 參數錯誤或報告無法讀取。
//
// 判定規則（Req 5.4）：
//   - 每個項目所需視窗：desktop；critical 項目另需 mobile（Req 5.7）。
//   - 任一對應測試案例在所需視窗的最終結果為 failed（含 timedOut、interrupted）→ fail。
//   - 否則任一對應測試案例在所需視窗不存在或未執行（含 skipped，skipped 視為「未執行」）→ missing。
//   - 否則（全部 passed）→ pass。
//   - 同一 TC ID 於同一視窗出現多個測試時：任一 failed → failed；否則任一 skipped → skipped；否則 passed。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLES = Object.freeze(['anonymous', 'member', 'admin']);
export const VIEWPORTS = Object.freeze(['desktop', 'mobile']);
const STRING_FIELDS = Object.freeze(['id', 'page', 'control', 'role', 'scenario', 'expected']);

// 測試案例 ID：TC-<area>-<nnn>；area 為大寫英數（可含連字號分段），nnn 至少 3 位數字。
export const TEST_CASE_ID_RE = /^TC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3,}$/;
// 測試標題中的 [TC-...] 標記（可出現多個）。
const TITLE_ID_RE = /\[(TC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3,})\]/g;

// 越權項目的預期結果須同時表達「操作被拒絕」與「資料未被變更」（Req 5.2）。以關鍵字判定。
const REJECT_WORDS = ['拒絕', '被拒', '禁止', '不允許', '401', '403', 'reject', 'denied', 'forbidden', 'unauthorized'];
const UNCHANGED_WORDS = ['未變更', '未被變更', '不變', '未改變', '未修改', '未被修改', '未更動', '沒有變更', '不會變更', '不受影響', 'unchanged', 'not modified', 'not changed'];

const includesAny = (text, words) => {
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w.toLowerCase()));
};
const nonEmptyString = v => typeof v === 'string' && v.trim() !== '';

/**
 * 驗證 QA_Inventory 文件（設計文件「QA_Inventory（qa/inventory.json）」格式）。
 * @param {unknown} doc 已解析的 JSON（或 JSON 字串）
 */
export function validateInventory(doc) {
  const errors = [];
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { return { ok: false, errors: [{ id: null, reason: 'inventory 無法解析為 JSON' }] }; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: [{ id: null, reason: 'inventory 必須為 JSON 物件' }] };
  }
  if (doc.version !== 1) errors.push({ id: null, reason: 'version 必須為 1' });
  if (!Array.isArray(doc.items)) {
    errors.push({ id: null, reason: 'items 必須為陣列' });
    return { ok: false, errors };
  }
  if (doc.items.length === 0) errors.push({ id: null, reason: 'items 不得為空' });

  const seen = new Map();
  const roles = new Set();
  let anonUnauthorized = false;
  let memberUnauthorized = false;

  doc.items.forEach((item, index) => {
    const id = item && typeof item === 'object' && nonEmptyString(item.id) ? item.id : null;
    const ref = id ?? `#${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ id: ref, reason: '項目必須為物件' });
      return;
    }
    let valid = true;
    const fail = reason => { valid = false; errors.push({ id: ref, reason }); };

    for (const field of STRING_FIELDS) {
      if (!nonEmptyString(item[field])) fail(`欄位 ${field} 缺少或為空值`);
    }
    if (id !== null) {
      if (seen.has(id)) fail('項目 ID 重複');
      else seen.set(id, index);
    }
    if (nonEmptyString(item.role) && !ROLES.includes(item.role)) fail(`角色 ${JSON.stringify(item.role)} 不屬於 ${ROLES.join('、')}`);
    if (!Array.isArray(item.testCases) || item.testCases.length === 0) {
      fail('欄位 testCases 缺少或為空值（至少 1 個測試案例 ID）');
    } else {
      item.testCases.forEach((tc, i) => {
        if (!nonEmptyString(tc)) fail(`testCases[${i}] 為空值`);
        else if (!TEST_CASE_ID_RE.test(tc)) fail(`testCases[${i}] ${JSON.stringify(tc)} 不符合 TC-<area>-<nnn>`);
      });
      if (new Set(item.testCases).size !== item.testCases.length) fail('testCases 含重複 ID');
    }
    if (typeof item.critical !== 'boolean') fail('欄位 critical 缺少或不是布林值');
    if (item.unauthorized !== undefined && typeof item.unauthorized !== 'boolean') fail('欄位 unauthorized 不是布林值');

    if (item.unauthorized === true && nonEmptyString(item.expected)) {
      if (!includesAny(item.expected, REJECT_WORDS) || !includesAny(item.expected, UNCHANGED_WORDS)) {
        fail('越權項目的 expected 須說明操作被拒絕且資料未被變更');
      }
    }
    if (item.unauthorized === true && item.role === 'admin') fail('越權項目的角色必須為 anonymous 或 member');

    if (!valid) return;
    roles.add(item.role);
    if (item.unauthorized === true && item.role === 'anonymous') anonUnauthorized = true;
    if (item.unauthorized === true && item.role === 'member') memberUnauthorized = true;
  });

  for (const role of ROLES) {
    if (!roles.has(role)) errors.push({ id: null, reason: `缺少角色 ${role} 的合格項目` });
  }
  if (!anonUnauthorized) errors.push({ id: null, reason: '缺少未登入者存取需登入功能的越權項目（role=anonymous、unauthorized=true）' });
  if (!memberUnauthorized) errors.push({ id: null, reason: '缺少 member 存取僅限 admin 功能的越權項目（role=member、unauthorized=true）' });

  return { ok: errors.length === 0, errors };
}

function finalOutcome(test) {
  const results = Array.isArray(test?.results) ? [...test.results] : [];
  if (results.length === 0) return test?.status === 'skipped' ? 'skipped' : 'absent';
  results.sort((a, b) => (a?.retry ?? 0) - (b?.retry ?? 0));
  const status = results.at(-1)?.status;
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') return 'failed';
  return 'absent';
}

/**
 * 由 Playwright JSON reporter 輸出（suites → specs → tests → results）取出 TC 結果。
 * @returns {{testCase:string, viewport:string, outcome:'passed'|'failed'|'skipped'|'absent'}[]}
 */
export function extractResults(report) {
  const out = [];
  const visitSuite = suite => {
    if (!suite || typeof suite !== 'object') return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const title = typeof spec?.title === 'string' ? spec.title : '';
      const ids = [...new Set([...title.matchAll(TITLE_ID_RE)].map(m => m[1]))];
      if (ids.length === 0) continue;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        const viewport = test?.projectName ?? test?.projectId;
        if (typeof viewport !== 'string') continue;
        const outcome = finalOutcome(test);
        for (const testCase of ids) out.push({ testCase, viewport, outcome });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visitSuite(child);
  };
  for (const suite of Array.isArray(report?.suites) ? report.suites : []) visitSuite(suite);
  return out;
}

const RANK = { failed: 3, skipped: 2, absent: 1, passed: 0 };

function indexResults(results) {
  const map = new Map();
  for (const r of results) {
    const key = `${r.testCase}\u0000${r.viewport}`;
    const prev = map.get(key);
    // 同一 TC × 視窗多筆：failed > skipped > absent > passed（取最差結果）。
    if (prev === undefined || RANK[r.outcome] > RANK[prev]) map.set(key, r.outcome);
  }
  return map;
}

/**
 * 比對 QA_Inventory 與測試結果。inventory 須先通過 validateInventory。
 * @param {{items:object[]}} inventory
 * @param {object | {testCase:string, viewport:string, outcome:string}[]} results Playwright JSON 報告或 extractResults 的結果
 */
export function compareInventory(inventory, results) {
  const list = Array.isArray(results) ? results : extractResults(results);
  const index = indexResults(list);
  const items = inventory.items.map(item => {
    const viewports = item.critical ? VIEWPORTS : ['desktop'];
    const detail = [];
    for (const testCase of item.testCases) {
      for (const viewport of viewports) {
        detail.push({ testCase, viewport, outcome: index.get(`${testCase}\u0000${viewport}`) ?? 'absent' });
      }
    }
    const status = detail.some(d => d.outcome === 'failed') ? 'fail'
      : detail.some(d => d.outcome !== 'passed') ? 'missing'
        : 'pass';
    return { id: item.id, status, detail };
  });
  const failed = items.filter(i => i.status === 'fail').map(i => i.id);
  const missing = items.filter(i => i.status === 'missing').map(i => i.id);
  return { ok: failed.length === 0 && missing.length === 0, items, failed, missing };
}

// ---------- CLI ----------

const USAGE = [
  '用法：',
  '  bun scripts/qa-inventory.mjs validate [qa/inventory.json]',
  '  bun scripts/qa-inventory.mjs compare [qa/inventory.json] [reports/e2e.json] [--out reports/qa-inventory.json]',
].join('\n');

function readInventory(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    return { validation: { ok: false, errors: [{ id: null, reason: `無法讀取 inventory 檔案（${e.code ?? 'unknown'}）` }] } };
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    return { validation: { ok: false, errors: [{ id: null, reason: 'inventory 無法解析為 JSON' }] } };
  }
  return { doc, validation: validateInventory(doc) };
}

function printErrors(errors, error) {
  for (const e of errors) error(`不合格 ${e.id ?? '(inventory)'}: ${e.reason}`);
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const [command, ...rest] = argv;
  const positional = [];
  let out = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') {
      if (i + 1 >= rest.length) { error(USAGE); return 2; }
      out = rest[++i];
    } else positional.push(rest[i]);
  }

  if (command === 'validate') {
    if (positional.length > 1 || out) { error(USAGE); return 2; }
    const { validation } = readInventory(positional[0] ?? 'qa/inventory.json');
    log(JSON.stringify({ command: 'validate', ...validation }, null, 2));
    if (!validation.ok) { printErrors(validation.errors, error); return 1; }
    return 0;
  }

  if (command === 'compare') {
    if (positional.length > 2) { error(USAGE); return 2; }
    const inventoryPath = positional[0] ?? 'qa/inventory.json';
    const reportPath = positional[1] ?? 'reports/e2e.json';
    const { doc, validation } = readInventory(inventoryPath);
    if (!validation.ok) {
      log(JSON.stringify({ command: 'compare', ok: false, validation }, null, 2));
      printErrors(validation.errors, error);
      return 1;
    }
    let report;
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch (e) {
      error(`無法讀取或解析 Playwright 報告 ${reportPath}（${e.code ?? 'parse error'}）`);
      return 2;
    }
    const result = compareInventory(doc, report);
    const json = JSON.stringify({ command: 'compare', ...result }, null, 2);
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, json + '\n');
    }
    log(json);
    for (const item of result.items) {
      if (item.status === 'pass') continue;
      const bad = item.detail.filter(d => d.outcome !== 'passed').map(d => `${d.testCase}@${d.viewport}=${d.outcome}`);
      error(`${item.status === 'fail' ? '失敗' : '缺少測試'} ${item.id}: ${bad.join(', ')}`);
    }
    return result.ok ? 0 : 1;
  }

  error(USAGE);
  return 2;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
