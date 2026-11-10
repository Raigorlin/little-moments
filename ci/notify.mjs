// 通知模組（Requirement 22.1–22.4、22.6–22.8；Design Components §16、Property 44）。
//
// 本檔是 ci/notify.groovy 的可測試參考實作：重試與「失敗不改建置結果」的規則在此以純邏輯表達，
// Groovy 端依相同規則實作（Groovy 無法在本機執行，行為以本檔的 property test 為準）。
//
// 純函式／純邏輯：
//   githubState(status)                  → 'pending' | 'success' | 'failure'
//     pending → pending；success → success；failure、aborted、timeout、rejected、error 及其他未知值 → failure
//     （Req 22.3：失敗、中止、逾時、核准被拒一律回報 failure；未知值 fail closed）
//   statusDescription(status, context)   → 不超過 140 字元的描述，只含狀態、失敗階段名稱與 7 字元短 SHA
//     （Req 22.3、22.4、22.8：不含秘密或使用者資料；stage 名稱只保留安全字元）
//   notifyWithRetry(channels, status, result, options) → Promise<NotifySummary>
//
// Channel 形狀：{ name: string, send: (status, context) => any | Promise<any> }
//   send 可為同步或非同步；正常回傳（或 resolve）即視為成功，throw（或 reject）即視為該次嘗試失敗。
//
// options：
//   context      傳給每個 send 的內容（預設 {}）
//   maxAttempts  每個管道最多嘗試次數，預設 4（初次 + 3 次重試，Req 22.7）
//   backoffMs    第 k 次重試前的等待毫秒數陣列（不足時沿用最後一項），預設 [1000, 2000, 4000]
//   sleep        (ms) => Promise，可注入以便測試不實際等待；預設 setTimeout
//
// NotifySummary 形狀：
//   { result,                                  // 與輸入完全相同（同一個值），通知結果絕不改變建置結果
//     deliveries: [{ channel, attempts, ok, error? }],
//     summary: string[] }                      // 每個最終失敗的管道一行「通知失敗：<channel>」
//   error 只放錯誤類別（例外的建構子名稱，例如 'Error'、'TypeError'），不放錯誤訊息，
//   避免訊息中夾帶權杖、URL 或回應內容（Req 22.8）。
//
// 保證：notifyWithRetry 永不 throw／reject（管道錯誤、sleep 錯誤、不合格的管道定義皆被吸收）。
// 管道依陣列順序逐一執行，前一個管道失敗不影響後續管道（Req 22.6：新增管道只需加入 channels）。

export const MAX_ATTEMPTS = 4;
export const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000]);
export const DESCRIPTION_MAX = 140;

const STATE_MAP = Object.freeze({ pending: 'pending', success: 'success' });

/** 建置狀態 → GitHub commit status 狀態。未知值一律 failure（fail closed）。 */
export function githubState(status) {
  const key = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return Object.hasOwn(STATE_MAP, key) ? STATE_MAP[key] : 'failure';
}

const LABELS = Object.freeze({ pending: '建置進行中', success: '建置成功', failure: '建置失敗' });

/** 只保留階段名稱中的安全字元（英數、空白、底線、連字號、斜線、點、括號與 CJK），避免任意內容外流。 */
function safeStage(stage) {
  if (typeof stage !== 'string') return '';
  return stage
    .replace(/[^\p{L}\p{N} _\-./()]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function shortSha(commit) {
  return typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7).toLowerCase() : '';
}

/**
 * GitHub commit status／Jenkins 摘要用的描述。只包含狀態、失敗階段與短 SHA（Req 22.8）。
 * @param {string} status
 * @param {{ commit?: string, failedStage?: string }} [context]
 */
export function statusDescription(status, context = {}) {
  const state = githubState(status);
  const parts = [LABELS[state]];
  const stage = state === 'failure' ? safeStage(context?.failedStage) : '';
  if (stage) parts.push(`失敗階段：${stage}`);
  const sha = shortSha(context?.commit);
  if (sha) parts.push(`commit ${sha}`);
  return parts.join(' · ').slice(0, DESCRIPTION_MAX);
}

/** 錯誤類別：只取建構子名稱（限英數），其餘一律 'Error'。不讀取 message。 */
function errorCategory(err) {
  try {
    const name = err?.constructor?.name ?? err?.name;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffFor(backoffMs, retryIndex) {
  if (!Array.isArray(backoffMs) || backoffMs.length === 0) return 0;
  const v = backoffMs[Math.min(retryIndex, backoffMs.length - 1)];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 依序對每個管道送出通知，每個管道最多嘗試 maxAttempts 次。永不 throw，且回傳的 result 與輸入相同。
 * @template R
 * @param {{name:string, send:Function}[]} channels
 * @param {string} status
 * @param {R} result
 * @param {{context?:object, maxAttempts?:number, backoffMs?:number[], sleep?:(ms:number)=>Promise<void>}} [options]
 * @returns {Promise<{result:R, deliveries:{channel:string, attempts:number, ok:boolean, error?:string}[], summary:string[]}>}
 */
export async function notifyWithRetry(channels, status, result, options = {}) {
  const {
    context = {},
    maxAttempts = MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
  } = options ?? {};
  const limit = Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 ? Math.min(maxAttempts, MAX_ATTEMPTS) : MAX_ATTEMPTS;

  const deliveries = [];
  const summary = [];
  const list = Array.isArray(channels) ? channels : [];

  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    const name = typeof ch?.name === 'string' && ch.name !== '' ? ch.name : `channel-${i}`;

    if (typeof ch?.send !== 'function') {
      deliveries.push({ channel: name, attempts: 0, ok: false, error: 'InvalidChannel' });
      summary.push(`通知失敗：${name}`);
      continue;
    }

    let attempts = 0;
    let ok = false;
    let error;
    while (attempts < limit && !ok) {
      if (attempts > 0) {
        try { await sleep(backoffFor(backoffMs, attempts - 1)); } catch { /* 等待失敗不影響重試 */ }
      }
      attempts += 1;
      try {
        // 同步 throw 與非同步 reject 皆在此被吸收。
        await ch.send(status, context);
        ok = true;
        error = undefined;
      } catch (err) {
        error = errorCategory(err);
      }
    }

    const delivery = { channel: name, attempts, ok };
    if (!ok) {
      delivery.error = error ?? 'Error';
      summary.push(`通知失敗：${name}`);
    }
    deliveries.push(delivery);
  }

  return { result, deliveries, summary };
}
