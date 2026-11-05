import { validateReceiptBytes, sniffImageType, readImageSize, MAX_RECEIPT_PIXELS } from './receipt-ocr.js';
import { EXPENSE_CATEGORIES, suggestExpenseCategory } from './expense-categories.js';

export const AI_CONSENT = 'openai-v1';
export const AI_PROVIDER = 'OpenAI';
export const AI_MAX_BYTES = 3.5 * 1024 * 1024;
export const AI_MAX_SIDE = 8000;
export const AI_TARGET_EDGE = 2400;
export const AI_TIMEOUT_MS = 60000;
export const AI_MAX_ROWS = 150;
const JPEG_QUALITIES = [0.9, 0.8];
const LINE_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d{1,7}(?:\.\d{1,2})?$/;
const QUANTITY_RE = /^\d{1,4}(?:\.\d{1,3})?$/;

export class ReceiptAiError extends Error {
  constructor(code, message, { uploaded = false } = {}) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'ReceiptAiError';
    this.code = code;
    this.uploaded = uploaded;
  }
}
const fail = (code, message, extra) => new ReceiptAiError(code, message, extra);

export const receiptAiPath = tripId => `/api/trips/${encodeURIComponent(String(tripId ?? ''))}/receipt-ai`;

export function normalizeAiStatus(data) {
  const limit = Number.isSafeInteger(data?.maxImageBytes) && data.maxImageBytes > 0 ? Math.min(data.maxImageBytes, AI_MAX_BYTES) : 0;
  const modelId = typeof data?.modelId === 'string' && /^[A-Za-z0-9][A-Za-z0-9.:-]{0,199}$/.test(data.modelId) ? data.modelId : '';
  const enabled = data?.enabled === true && data?.provider === AI_PROVIDER && Boolean(modelId && limit);
  return { enabled, provider: AI_PROVIDER, modelId: enabled ? modelId : '', maxImageBytes: enabled ? limit : 0 };
}

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isIso = value => {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
};
const malformed = () => fail('malformed', 'AI 回傳的內容格式不正確，沒有產生任何候選品項。請稍後重試或手動輸入。');
const optionalText = (value, re) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw malformed();
  const text = value.trim();
  return re.test(text) ? text : null;
};

export function normalizeAiReceipt(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.items) || data.items.length > AI_MAX_ROWS) throw malformed();
  const warnings = (Array.isArray(data.warnings) ? data.warnings : typeof data.warnings === 'string' ? [data.warnings] : [])
    .slice(0, 30).map(w => clean(w, 200)).filter(Boolean);
  const totalCents = Number.isSafeInteger(data.totalCents) && data.totalCents > 0 && data.totalCents <= 100000000 ? data.totalCents : null;
  const date = typeof data.date === 'string' && isIso(data.date) ? data.date : '';
  const used = new Set();
  const items = data.items.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw malformed();
    if (row.title !== undefined && row.title !== null && typeof row.title !== 'string') throw malformed();
    const notes = [];
    const title = clean(row.title, 100);
    let amount = optionalText(row.amount, AMOUNT_RE);
    if (amount === null) { amount = ''; notes.push('金額格式無法辨識，請手動填寫'); }
    let quantity = optionalText(row.quantity, QUANTITY_RE);
    if (quantity === null) quantity = '';
    let unitPrice = optionalText(row.unitPrice, AMOUNT_RE);
    if (unitPrice === null) unitPrice = '';
    let category = typeof row.category === 'string' && EXPENSE_CATEGORIES.includes(row.category) ? row.category : '';
    if (!category) { category = suggestExpenseCategory(title); notes.push('AI 分類不在清單中，已改用建議分類'); }
    let lineId = typeof row.lineId === 'string' && LINE_RE.test(row.lineId) ? row.lineId : `AI-${i + 1}`;
    for (let n = 2; used.has(lineId); n++) lineId = `AI-${i + 1}-${n}`;
    used.add(lineId);
    const warning = [clean(row.warning, 300), ...notes].filter(Boolean).join('；');
    return { lineId, title, amount, quantity, unitPrice, category, warning };
  });
  return { store: clean(data.store, 100), date, totalCents, items, warnings: [...new Set(warnings)] };
}

function decodeError() { return fail('decode', '瀏覽器無法讀取這張照片，請換一張 JPEG、PNG 或 WebP 照片。'); }

// Re-encoding through a canvas drops EXIF/GPS metadata; colour is kept because the model reads coloured labels.
export async function prepareAiImage(file, { maxBytes = AI_MAX_BYTES, signal } = {}) {
  if (!(file instanceof Blob)) throw fail('type', '請選擇一張收據照片。');
  const original = new Uint8Array(await file.arrayBuffer());
  validateReceiptBytes(original, file.type);
  if (signal?.aborted) throw fail('aborted', '已取消，圖片沒有傳送。');
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([original], { type: sniffImageType(original) || file.type }), { imageOrientation: 'from-image' }); }
  catch { throw decodeError(); }
  try {
    if (!bitmap.width || !bitmap.height) throw decodeError();
    if (bitmap.width * bitmap.height > MAX_RECEIPT_PIXELS) throw fail('pixels', '照片解析度過高（超過 2,000 萬像素），請縮小後再試。');
    const scale = Math.min(1, AI_TARGET_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw decodeError();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const limit = Math.min(maxBytes, AI_MAX_BYTES);
    try {
      for (const quality of JPEG_QUALITIES) {
        if (signal?.aborted) throw fail('aborted', '已取消，圖片沒有傳送。');
        const blob = canvas.convertToBlob
          ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
          : await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) throw decodeError();
        if (blob.size > limit) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (sniffImageType(bytes) !== 'image/jpeg') throw decodeError();
        const size = readImageSize(bytes, 'image/jpeg');
        if (!size || size.width > AI_MAX_SIDE || size.height > AI_MAX_SIDE || size.width !== width || size.height !== height) throw decodeError();
        return { bytes, type: 'image/jpeg', width, height };
      }
    } finally { canvas.width = canvas.height = 0; }
    throw fail('tooLarge', `壓縮後的圖片仍超過 ${(limit / 1024 / 1024).toFixed(1)} MB，沒有傳送。請裁切成只有收據的範圍再試。`);
  } finally { bitmap.close?.(); }
}

const STATUS_MESSAGES = {
  400: '伺服器拒絕這張圖片（格式或尺寸不符），沒有產生候選品項。',
  401: '登入已失效，請重新登入後再試。',
  403: '你沒有使用 AI 辨識的權限，或收據上傳授權未送達。',
  404: '找不到 AI 辨識服務或這趟旅行，請重新整理頁面。',
  408: 'AI 辨識逾時，請稍後再試。',
  413: '圖片超過 AI 辨識的大小限制，請裁切後再試。',
  415: 'AI 辨識只接受處理後的 JPEG 或 PNG 圖片。',
  422: 'AI 無法確認這張收據的內容，請手動輸入。',
  429: 'AI 服務忙碌或已達使用上限，請稍後再試（不會自動重送）。',
  502: 'AI 服務沒有完成辨識，請稍後再試。',
  503: 'AI 辨識尚未設定或暫停使用，請聯絡管理員。',
  504: 'AI 辨識逾時，請稍後再試。'
};
// Server text is shown only when it is short plain prose, so provider internals or markup never reach the page.
export function sanitizeServerMessage(value) {
  const text = clean(value, 200);
  if (!text || text.length > 160 || /[<>{}`$\\]|https?:|www\.|arn:|[A-Za-z0-9+/=_-]{32,}/i.test(text)) return '';
  return /[\u3400-\u9fff]/.test(text) ? text : '';
}

export async function sendReceiptToAi({ tripId, userId, image, signal, timeoutMs = AI_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  if (!userId) throw fail('session', '無法確認登入帳號，沒有傳送圖片。');
  if (!image?.bytes?.length || !['image/jpeg', 'image/png'].includes(image.type)) throw fail('type', 'AI 辨識只接受處理後的 JPEG 或 PNG 圖片。');
  if (signal?.aborted) throw fail('aborted', '已取消，圖片沒有傳送。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(Math.max(1, timeoutMs), AI_TIMEOUT_MS));
  const stop = () => (timedOut
    ? fail('timeout', `等待 AI 回應超過 ${Math.round(Math.min(timeoutMs, AI_TIMEOUT_MS) / 1000)} 秒，已停止等待。圖片可能已傳送，不會自動重送。`, { uploaded: true })
    : fail('aborted', '已取消等待 AI 結果。', { uploaded: true }));
  try {
    let response;
    try {
      response = await fetchImpl(receiptAiPath(tripId), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': image.type, 'x-camping-user-id': String(userId), 'x-receipt-consent': AI_CONSENT },
        body: image.bytes
      });
    } catch {
      if (controller.signal.aborted) throw stop();
      throw fail('network', '無法連線到本機伺服器，無法確認圖片是否已送出。不會自動重送。', { uploaded: true });
    }
    let data = null;
    try { data = await response.json(); } catch { if (controller.signal.aborted) throw stop(); data = null; }
    if (!response.ok) {
      const base = STATUS_MESSAGES[response.status] || (response.status >= 500 ? STATUS_MESSAGES[502] : 'AI 辨識被伺服器拒絕。');
      const detail = sanitizeServerMessage(data?.error);
      throw Object.assign(fail('http', detail && detail !== base ? `${base}（${detail}）` : base, { uploaded: true }), { status: response.status });
    }
    if (controller.signal.aborted) throw stop();
    return normalizeAiReceipt(data);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
