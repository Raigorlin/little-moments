// Feature: jenkins-cicd-deploy, Property 6: QA_Inventory 驗證
// **Validates: Requirements 5.1, 5.2, 5.8**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { validateInventory, ROLES } from '../scripts/qa-inventory.mjs';

const RUNS = { numRuns: 200 };
const STRING_FIELDS = ['id', 'page', 'control', 'role', 'scenario', 'expected'];

// 合法項目。越權項目的 expected 一律同時含「拒絕」與「未變更」語意，越權角色只用 anonymous／member。
const tcId = fc.tuple(fc.constantFrom('AUTH', 'HOME', 'TRIP', 'ADMIN', 'UNAUTH', 'A1-B2'), fc.integer({ min: 1, max: 9999 }))
  .map(([area, n]) => `TC-${area}-${String(n).padStart(3, '0')}`);
const text = fc.constantFrom('首頁', '/login', 'login-form', '開啟頁面', 'save button', '設定');
const baseItem = fc.record({
  page: text,
  control: text,
  role: fc.constantFrom(...ROLES),
  scenario: text,
  testCases: fc.uniqueArray(tcId, { minLength: 1, maxLength: 3 }),
  critical: fc.boolean(),
  unauthorized: fc.option(fc.boolean(), { nil: undefined }),
}).map(item => {
  const unauthorized = item.unauthorized === true && item.role !== 'admin';
  const out = { ...item, expected: unauthorized ? '操作被拒絕（403），資料未被變更' : '顯示預期內容' };
  if (item.unauthorized === undefined) delete out.unauthorized;
  else out.unauthorized = unauthorized;
  return out;
});
// 保證三種角色與兩類越權項目都存在的必要項目。
const REQUIRED = [
  { page: '/admin', control: 'users', role: 'admin', scenario: '管理員檢視', expected: '顯示使用者', testCases: ['TC-ADMIN-001'], critical: true },
  { page: '/x/home', control: 'home', role: 'anonymous', scenario: '未登入', expected: '導向登入且被拒絕，資料不變', testCases: ['TC-UNAUTH-001'], critical: true, unauthorized: true },
  { page: '/admin', control: 'users', role: 'member', scenario: '越權', expected: '回應 403 forbidden，unchanged', testCases: ['TC-UNAUTH-003'], critical: false, unauthorized: true },
];

// 每種破壞都使該項目不合格；回傳 [描述, 套用函式]。
const CORRUPTIONS = [
  ...STRING_FIELDS.filter(f => f !== 'id').map(f => [`delete ${f}`, item => { delete item[f]; }]),
  ...STRING_FIELDS.map(f => [`empty ${f}`, item => { item[f] = ''; }]),
  ...STRING_FIELDS.map(f => [`blank ${f}`, item => { item[f] = '  \t'; }]),
  ['non-string page', item => { item.page = 42; }],
  ['illegal role', item => { item.role = 'guest'; }],
  ['case-mismatched role', item => { item.role = 'Admin'; }],
  ['empty testCases', item => { item.testCases = []; }],
  ['missing testCases', item => { delete item.testCases; }],
  ['malformed testCase', item => { item.testCases = ['tc-auth-001']; }],
  ['short testCase number', item => { item.testCases = ['TC-AUTH-01']; }],
  ['duplicate testCase', item => { item.testCases = ['TC-AUTH-001', 'TC-AUTH-001']; }],
  ['string critical', item => { item.critical = 'true'; }],
  ['missing critical', item => { delete item.critical; }],
  ['string unauthorized', item => { item.unauthorized = 'yes'; }],
  ['unauthorized without reject wording', item => { item.unauthorized = true; item.role = 'member'; item.expected = '資料未被變更'; }],
  ['unauthorized without unchanged wording', item => { item.unauthorized = true; item.role = 'anonymous'; item.expected = '回應 401 被拒絕'; }],
  ['unauthorized admin', item => { item.unauthorized = true; item.role = 'admin'; item.expected = '被拒絕且資料不變'; }],
];

// 產生 inventory 與其「不合格項目參照」oracle（參照規則同實作：有非空 id 用 id，否則 #index）。
// 原始輸入（欄位與 arbitrary 不可變更：記錄的 seed 依此重現相同的原始值）。
const scenarioInput = fc.record({
  includeRequired: fc.boolean(),
  extra: fc.array(baseItem, { maxLength: 8 }),
  shuffle: fc.array(fc.nat(), { maxLength: 12 }),
  corrupt: fc.array(fc.record({ at: fc.nat(), kind: fc.nat({ max: CORRUPTIONS.length - 1 }) }), { maxLength: 4 }),
  duplicates: fc.array(fc.record({ from: fc.nat(), to: fc.nat() }), { maxLength: 2 }),
});

// 先製造重複 ID、再套用破壞：破壞之後不再修改任何項目，因此每個被破壞的項目在最終資料中都不合格。
// （任務 28.6：原本先破壞再複製 id，複製會覆蓋 `empty id`／`blank id` 破壞，使項目變回合格，預期結果卻仍列為不合格。）
function buildScenario(s) {
  const items = [...(s.includeRequired ? REQUIRED.map(i => structuredClone(i)) : []), ...s.extra.map(i => structuredClone(i))];
  for (let k = 0; k < s.shuffle.length && items.length > 1; k++) {
    const a = k % items.length, b = s.shuffle[k] % items.length;
    [items[a], items[b]] = [items[b], items[a]];
  }
  items.forEach((item, i) => { item.id = `QA-ITEM-${String(i + 1).padStart(3, '0')}`; });
  const bad = new Set();
  if (items.length > 0) {
    // 製造重複 ID：把較早項目的 id 複製到較晚項目。
    for (const { from, to } of s.duplicates) {
      if (items.length < 2) break;
      const j = from % (items.length - 1), i = j + 1 + (to % (items.length - 1 - j));
      items[i].id = items[j].id;
    }
    for (const { at, kind } of s.corrupt) {
      const i = at % items.length;
      CORRUPTIONS[kind][1](items[i]);
      bad.add(i);
    }
    // 依最終 id 判定：非空 id 與任一較早項目相同者不合格（較早者只在本身有其他問題時才不合格）。
    const firstSeen = new Set();
    items.forEach((item, i) => {
      if (typeof item.id !== 'string' || item.id.trim() === '') { bad.add(i); return; }
      if (firstSeen.has(item.id)) bad.add(i);
      else firstSeen.add(item.id);
    });
  }
  const ref = (item, i) => (typeof item.id === 'string' && item.id.trim() !== '' ? item.id : `#${i}`);
  const badRefs = new Set([...bad].map(i => ref(items[i], i)));
  const good = items.filter((_, i) => !bad.has(i));
  const rolesCovered = ROLES.every(r => good.some(i => i.role === r));
  const anon = good.some(i => i.unauthorized === true && i.role === 'anonymous');
  const memberU = good.some(i => i.unauthorized === true && i.role === 'member');
  return { doc: { version: 1, items }, badRefs, globalOk: items.length > 0 && rolesCovered && anon && memberU };
}
const scenario = scenarioInput.map(buildScenario);

// 性質本體：主測試、seed 重播與固定案例共用。
function checkScenario({ doc, badRefs, globalOk }) {
  const result = validateInventory(structuredClone(doc));
  expect(result.ok).toBe(badRefs.size === 0 && globalOk);
  const reported = new Set(result.errors.filter(e => e.id !== null).map(e => e.id));
  expect(reported).toEqual(badRefs);
  // 全域錯誤（id 為 null）只在全域條件不成立時出現。
  expect(result.errors.some(e => e.id === null)).toBe(!globalOk);
  for (const e of result.errors) expect(typeof e.reason).toBe('string');
}

// 任務 28.6 的回歸資料：seed -296340450 以修正前的產生器縮減後的反例（Bun 1.4.4，run 126、61 次縮減）。
const HOME_ITEM = { page: '首頁', control: '首頁', role: 'anonymous', scenario: '首頁', testCases: ['TC-AUTH-001'], critical: false, expected: '顯示預期內容' };
const SHRUNK_INPUT = {
  includeRequired: true,
  extra: [HOME_ITEM, HOME_ITEM, HOME_ITEM, HOME_ITEM, HOME_ITEM],
  shuffle: [],
  corrupt: [{ at: 1195228886, kind: 5 }],
  duplicates: [{ from: 1325549446, to: 1360348630 }, { from: 1273066117, to: 576675554 }],
};
// 修正前的產生器對 SHRUNK_INPUT 的輸出：index 6 先被 `empty id` 破壞，之後重複 ID 步驟把 QA-ITEM-005 複製到 index 6、
// 把 QA-ITEM-002 複製到 index 4；index 6 因此變回合格，預期結果卻是 {QA-ITEM-005, QA-ITEM-002}。
const SHRUNK_LEGACY_DOC = {
  version: 1,
  items: [
    { ...REQUIRED[0], id: 'QA-ITEM-001' },
    { ...REQUIRED[1], id: 'QA-ITEM-002' },
    { ...REQUIRED[2], id: 'QA-ITEM-003' },
    ...['QA-ITEM-004', 'QA-ITEM-002', 'QA-ITEM-006', 'QA-ITEM-005', 'QA-ITEM-008'].map(id => ({ ...HOME_ITEM, id })),
  ],
};

describe('Property 6: QA_Inventory 驗證', () => {
  test('接受若且唯若沒有不合格項目且全域條件成立；回報的項目 ID 恰為不合格項目', () => {
    fc.assert(fc.property(scenario, checkScenario), RUNS);
  });

  test('回歸：重播 28.3 記錄的 seed', () => {
    for (const seed of [-296340450, 405161941]) {
      fc.assert(fc.property(scenario, checkScenario), { ...RUNS, seed });
    }
  });

  test('回歸：修正前產生器的縮減反例只有 QA-ITEM-002 的 ID 重複', () => {
    expect(validateInventory(structuredClone(SHRUNK_LEGACY_DOC))).toEqual({
      ok: false,
      errors: [{ id: 'QA-ITEM-002', reason: '項目 ID 重複' }],
    });
  });

  test('回歸：同一組原始值經修正後的產生器，性質成立', () => {
    checkScenario(buildScenario(structuredClone(SHRUNK_INPUT)));
  });

  test('必要項目齊全的合法 inventory 一律通過，JSON 字串輸入結果相同', () => {
    fc.assert(
      fc.property(fc.array(baseItem, { maxLength: 6 }), extra => {
        const items = [...REQUIRED, ...extra].map((item, i) => ({ ...structuredClone(item), id: `QA-OK-${i + 1}` }));
        const doc = { version: 1, items };
        expect(validateInventory(doc)).toEqual({ ok: true, errors: [] });
        expect(validateInventory(JSON.stringify(doc))).toEqual({ ok: true, errors: [] });
      }),
      RUNS,
    );
  });

  test('移除任一必要角色或越權類別即拒絕，且只回報全域錯誤', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: REQUIRED.length - 1 }), drop => {
        const items = REQUIRED.filter((_, i) => i !== drop).map((item, i) => ({ ...structuredClone(item), id: `QA-R-${i}` }));
        const result = validateInventory({ version: 1, items });
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.every(e => e.id === null)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  test('文件層級錯誤：非物件、非陣列 items、空 items、錯誤版本、無效 JSON', () => {
    const items = REQUIRED.map((item, i) => ({ ...item, id: `QA-D-${i}` }));
    for (const doc of [null, [], 7, '{bad json', { version: 1 }, { version: 1, items: {} }, { version: 1, items: [] }, { version: 2, items }]) {
      const result = validateInventory(doc);
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.id === null)).toBe(true);
    }
    // 非物件項目以 #index 參照。
    const result = validateInventory({ version: 1, items: [...items, 'oops', null] });
    expect(new Set(result.errors.map(e => e.id))).toEqual(new Set([`#${items.length}`, `#${items.length + 1}`]));
  });

  test('專案內的 qa/inventory.json 通過驗證', async () => {
    const doc = await Bun.file(new URL('../qa/inventory.json', import.meta.url)).json();
    expect(validateInventory(doc)).toEqual({ ok: true, errors: [] });
  });
});
