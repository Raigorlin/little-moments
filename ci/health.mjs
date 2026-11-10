// 健康檢查判定（Req 18.3、18.5、20.3、20.4、20.6、20.11；Design Property 40）。
//
// 純函式：
//   isHealthSuccess(result)                          → boolean（HTTP 200 且 5 秒內回應）
//   healthyAt(results, windowSec = 120, n = 3)       → 第 n 次連續成功的 t（秒）| null
//   healthyWithin(results, windowSec = 120, n = 3)   → boolean
//   shouldRollback(observations, { consecutive = 3, periodSec = 600 }) → Trigger | null
//
// HealthResult 形狀：{ t: number（自容器啟動或切換起算的秒數）, ok?: boolean, status?: number, durationMs?: number }
//   成功條件：(ok === true 或 status === 200) 且 durationMs（若提供）≤ 5000。其餘（含格式無效）一律視為失敗。
// Observation 形狀：{ type: 'health' | 'smoke', t?: number, ok?/status?/durationMs? }，依陣列順序評估。
// Trigger 形狀：{ index, t, reason: 'health_consecutive_failures' | 'smoke_failed', failures?: number[] }
//   index 為觀察序列中第一個滿足回滾條件的位置。
//
// CLI（輸入為 JSON 檔案路徑或 stdin）：
//   bun ci/health.mjs startup [--window 120] [--n 3] [input.json]
//     input：HealthResult[]；結束碼 0 健康、1 未健康
//   bun ci/health.mjs observe [--consecutive 3] [--period 600] [input.json]
//     input：Observation[]；輸出 { rollback, trigger }；結束碼 0 不需回滾、1 需回滾
//   結束碼 2：參數或輸入錯誤。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEALTH_TIMEOUT_MS = 5000;

const isTime = (t) => typeof t === 'number' && Number.isFinite(t);

function assertPositiveInt(name, v) {
  if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`${name} 必須是正整數`);
}

/** Health_Check 成功：HTTP 200 且於 5 秒內回應（Requirements Glossary）。 */
export function isHealthSuccess(r) {
  if (!r || typeof r !== 'object') return false;
  const okFlag = r.ok === true || (r.ok === undefined && r.status === 200);
  if (!okFlag) return false;
  if (r.status !== undefined && r.status !== 200) return false;
  if (r.durationMs !== undefined && !(isTime(r.durationMs) && r.durationMs >= 0 && r.durationMs <= HEALTH_TIMEOUT_MS)) return false;
  return true;
}

/**
 * 回傳視窗 [0, windowSec] 內第一次達成連續 n 次成功的時間點（第 n 次成功的 t），否則 null。
 * 視窗外或缺少有效 t 的結果不計入視窗；結果依 t 排序（相同 t 保持輸入順序）。
 */
export function healthyAt(results, windowSec = 120, n = 3) {
  if (!Array.isArray(results)) throw new TypeError('results 必須是陣列');
  if (!(isTime(windowSec) && windowSec >= 0)) throw new TypeError('windowSec 必須是非負數');
  assertPositiveInt('n', n);
  const inWindow = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && isTime(r.t) && r.t >= 0 && r.t <= windowSec)
    .sort((a, b) => a.r.t - b.r.t || a.i - b.i);
  let streak = 0;
  for (const { r } of inWindow) {
    streak = isHealthSuccess(r) ? streak + 1 : 0;
    if (streak >= n) return r.t;
  }
  return null;
}

/** 視窗內存在連續 n 次成功（Req 18.3、20.3、20.4、20.11）。 */
export function healthyWithin(results, windowSec = 120, n = 3) {
  return healthyAt(results, windowSec, n) !== null;
}

/**
 * 觀察期回滾判定（Req 18.5、20.6）：依序檢視觀察結果，回傳第一個觸發點：
 * - 健康檢查連續 consecutive 次失敗（Smoke_Test 項目不中斷也不重置健康檢查的連續計數）；
 * - 任一 Smoke_Test 失敗。
 * t 為數值且大於 periodSec 的項目不在觀察期內，略過。不需回滾時回傳 null。
 */
export function shouldRollback(observations, { consecutive = 3, periodSec = 600 } = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations 必須是陣列');
  assertPositiveInt('consecutive', consecutive);
  if (!(isTime(periodSec) && periodSec >= 0)) throw new TypeError('periodSec 必須是非負數');
  let failures = [];
  for (let index = 0; index < observations.length; index++) {
    const o = observations[index];
    if (o && isTime(o.t) && (o.t > periodSec || o.t < 0)) continue;
    const t = o && isTime(o.t) ? o.t : null;
    const type = o?.type;
    if (type === 'smoke') {
      if (!isHealthSuccess(o)) return { index, t, reason: 'smoke_failed' };
      continue;
    }
    // 'health' 或無法辨識的項目都以健康檢查處理；格式無效即為失敗（fail closed）。
    if (isHealthSuccess(type === 'health' ? o : null)) {
      failures = [];
    } else {
      failures.push(index);
      if (failures.length >= consecutive) {
        return { index, t, reason: 'health_consecutive_failures', failures: [...failures] };
      }
    }
  }
  return null;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, file: null };
  const numeric = new Set(['--window', '--n', '--consecutive', '--period']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (numeric.has(a)) {
      if (i + 1 >= rest.length || !/^\d+$/.test(rest[i + 1])) return null;
      opts[a.slice(2)] = Number(rest[++i]);
    } else if (!opts.file) opts.file = a;
    else return null;
  }
  return opts;
}

const USAGE = '用法：bun ci/health.mjs startup [--window 120] [--n 3] [input.json] | '
  + 'observe [--consecutive 3] [--period 600] [input.json]';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readInput } = {}) {
  const opts = parseArgs(argv);
  if (!opts || !['startup', 'observe'].includes(opts.cmd)) {
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
    if (opts.cmd === 'startup') {
      const at = healthyAt(input, opts.window ?? 120, opts.n ?? 3);
      log(JSON.stringify({ healthy: at !== null, at }));
      if (at === null) error('視窗內未達成連續成功的 Health_Check');
      return at === null ? 1 : 0;
    }
    const trigger = shouldRollback(input, { consecutive: opts.consecutive ?? 3, periodSec: opts.period ?? 600 });
    log(JSON.stringify({ rollback: trigger !== null, trigger }));
    if (trigger) error(`觸發回滾：${trigger.reason}（第 ${trigger.index} 筆觀察）`);
    return trigger ? 1 : 0;
  } catch (e) {
    error(`輸入無效：${e.message}`);
    return 2;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
