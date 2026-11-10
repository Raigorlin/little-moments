// 比對 Build_Image 實際工具版本與 ci/toolchain.json（Req 3.2、3.3）。
// 純函式供 property test 使用；CLI 只在直接執行時啟動。
//
// 用法：bun ci/verify-toolchain.mjs [--expected ci/toolchain.json] [--out reports/toolchain.json]
//                                   [--record-patch reports/toolchain-patch.json]
// 結束碼：0 一致；1 不一致或無法取得版本。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = Object.freeze(['bun', 'node', 'chromium']);

/**
 * @param {Record<string, string|null|undefined>} expected
 * @param {Record<string, string|null|undefined>} actual
 * @returns {{ok: boolean, mismatches: {tool: string, expected: string|null, actual: string|null}[]}}
 */
export function compareToolchain(expected, actual) {
  const mismatches = [];
  for (const tool of TOOLS) {
    const want = normalize(expected?.[tool]);
    const got = normalize(actual?.[tool]);
    if (want === null || want !== got) mismatches.push({ tool, expected: want, actual: got });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function normalize(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 從 `--version` 輸出取出版本號；無法辨識時回傳 null。 */
export function parseVersionOutput(tool, output) {
  const text = String(output ?? '').trim();
  const patterns = {
    bun: /^(\d+\.\d+\.\d+)$/m,
    node: /^v(\d+\.\d+\.\d+)$/m,
    chromium: /\b(?:Chromium|Google Chrome(?: for Testing)?)\s+(\d+\.\d+\.\d+\.\d+)\b/,
  };
  const m = patterns[tool]?.exec(text);
  return m ? m[1] : null;
}

/** Build_Record 的 toolchain 區段。 */
export function toolchainRecord(expected, actual, comparison = compareToolchain(expected, actual)) {
  return {
    expected: Object.fromEntries(TOOLS.map(t => [t, normalize(expected?.[t])])),
    actual: Object.fromEntries(TOOLS.map(t => [t, normalize(actual?.[t])])),
    ok: comparison.ok,
    mismatches: comparison.mismatches,
  };
}

/**
 * 供 `bun ci/record.mjs merge` 使用的 Build_Record patch（Req 3.3）：
 * toolchain 區段寫入實際版本（無法取得者為 null，finalize 時標示「未執行」），
 * 不一致的工具名稱、預期與實際版本保存在 reportPath 指向的報告，並由 reports.toolchain 引用。
 */
export function recordPatch(record, reportPath) {
  const actual = record?.actual ?? {};
  const patch = { toolchain: Object.fromEntries(TOOLS.map(t => [t, normalize(actual[t])])) };
  if (typeof reportPath === 'string' && reportPath !== '') patch.reports = { toolchain: reportPath };
  return patch;
}

function readActual(env) {
  const commands = {
    bun: env.CAMPING_BUN || 'bun',
    node: 'node',
    chromium: env.CHROME_PATH || 'chromium',
  };
  const actual = {};
  for (const tool of TOOLS) {
    const r = spawnSync(commands[tool], ['--version'], { encoding: 'utf8', timeout: 30_000 });
    actual[tool] = r.status === 0 ? parseVersionOutput(tool, r.stdout) : null;
  }
  return actual;
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const expected = JSON.parse(readFileSync(arg(argv, '--expected', resolve(root, 'ci/toolchain.json')), 'utf8'));
  const actual = readActual(process.env);
  const record = toolchainRecord(expected, actual);
  const out = arg(argv, '--out', null);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  }
  const patchOut = arg(argv, '--record-patch', null);
  if (patchOut) {
    mkdirSync(dirname(resolve(patchOut)), { recursive: true });
    writeFileSync(patchOut, JSON.stringify(recordPatch(record, out), null, 2) + '\n');
  }
  console.log(JSON.stringify(record));
  for (const m of record.mismatches) {
    console.error(`工具鏈版本不一致 ${m.tool}: 預期 ${m.expected ?? '未設定'}，實際 ${m.actual ?? '無法取得'}`);
  }
  return record.ok ? 0 : 1;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
