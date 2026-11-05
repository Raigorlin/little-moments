export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_RECEIPT_PIXELS = 20000000;
export const OCR_TIMEOUT_MS = 90000;
export const OCR_ASSETS = Object.freeze({
  workerPath: '/assets/ocr/worker.min.js',
  corePath: '/assets/ocr/core',
  langPath: '/assets/ocr/lang',
});
const OCR_LANGS = ['chi_tra', 'eng'];
const OEM_LSTM_ONLY = 1;
const OCR_TARGET_PIXELS = 8000000;
const OCR_MIN_LONG_SIDE = 1600;

const STAGES = {
  'loading tesseract core': [0.05, 0.1, '正在載入辨識核心'],
  'initializing tesseract': [0.15, 0, '正在啟動辨識核心'],
  'loading language traineddata': [0.15, 0.3, '正在載入繁體中文與英文字庫'],
  'initializing api': [0.45, 0.05, '正在初始化辨識'],
  'recognizing text': [0.5, 0.49, '正在辨識文字'],
};

class ReceiptOcrError extends Error {
  constructor(message, code) { super(message); this.name = code === 'aborted' ? 'AbortError' : 'ReceiptOcrError'; this.code = code; }
}
const fail = (code, message) => new ReceiptOcrError(message, code);

export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function readImageSize(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === 'image/png') return {width: view.getUint32(16), height: view.getUint32(20)};
    if (type === 'image/webp') {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      const u24 = at => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      if (chunk === 'VP8X') return bytes.length < 30 ? null : {width: 1 + u24(24), height: 1 + u24(27)};
      if (chunk === 'VP8L') { const bits = view.getUint32(21, true); return {width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff)}; }
      if (chunk === 'VP8 ') return {width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
      return null;
    }
    if (type === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xff) { offset += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {width: view.getUint16(offset + 7), height: view.getUint16(offset + 5)};
        offset += 2 + view.getUint16(offset + 2);
      }
    }
  } catch { return null; }
  return null;
}

export function validateReceiptBytes(bytes, declaredType = '') {
  if (!bytes.length) throw fail('empty', '這張照片是空檔案，請重新選擇。');
  if (bytes.length > MAX_RECEIPT_BYTES) throw fail('tooLarge', '照片超過 10 MB，請壓縮或裁切後再試。');
  const type = sniffImageType(bytes);
  if (!type || (declaredType && !['image/jpeg', 'image/png', 'image/webp'].includes(declaredType))) throw fail('type', '只支援 JPEG、PNG 或 WebP 照片。');
  const size = readImageSize(bytes, type);
  if (size && (!size.width || !size.height)) throw fail('decode', '照片無法讀取，請換一張再試。');
  if (size && size.width * size.height > MAX_RECEIPT_PIXELS) throw fail('pixels', '照片解析度過高（超過 2,000 萬像素），請縮小後再試。');
  return {type, size};
}

export function planOcrSize(width, height) {
  const pixels = width * height;
  let scale = 1;
  if (pixels > OCR_TARGET_PIXELS) scale = Math.sqrt(OCR_TARGET_PIXELS / pixels);
  else if (Math.max(width, height) < OCR_MIN_LONG_SIDE) scale = Math.min(2, OCR_MIN_LONG_SIDE / Math.max(width, height), Math.sqrt(OCR_TARGET_PIXELS / pixels));
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

// Grayscale + resize only: no thresholding or contrast curves, so faint digits are never erased before OCR.
async function normalizeImage(blob) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob, {imageOrientation: 'from-image'}); }
  catch { throw fail('decode', '照片無法解碼，請確認是 JPEG、PNG 或 WebP 格式。'); }
  try {
    if (bitmap.width * bitmap.height > MAX_RECEIPT_PIXELS) throw fail('pixels', '照片解析度過高（超過 2,000 萬像素），請縮小後再試。');
    const {width, height} = planOcrSize(bitmap.width, bitmap.height);
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), {width, height});
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) throw fail('decode', '瀏覽器無法處理這張照片，請換一個瀏覽器再試。');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height), px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114 + 500) / 1000 | 0;
      px[i] = px[i + 1] = px[i + 2] = y;
      px[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const png = canvas.convertToBlob
      ? await canvas.convertToBlob({type: 'image/png'})
      : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = canvas.height = 0;
    if (!png) throw fail('decode', '瀏覽器無法處理這張照片，請換一個瀏覽器再試。');
    return png;
  } finally { bitmap.close?.(); }
}

const absolute = path => new URL(path, globalThis.location?.origin || 'http://localhost').href;

// tesseract.js only exposes the Worker after language data finishes loading, so capture it at
// construction (spawned synchronously inside createWorker) to make cancel/timeout terminate immediately.
function spawnTracked(createWorker, options, onError) {
  const Native = globalThis.Worker;
  if (typeof Native !== 'function') throw fail('unsupported', '這個瀏覽器不支援背景辨識，請改用最新版 Chrome、Edge 或 Safari。');
  let spawned = null;
  globalThis.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      spawned = this;
      this.addEventListener('error', onError);
      this.addEventListener('messageerror', onError);
    }
  };
  let pending;
  try { pending = createWorker(OCR_LANGS, OEM_LSTM_ONLY, options); }
  finally { globalThis.Worker = Native; }
  return {pending, kill: () => spawned?.terminate()};
}

function describeFailure(err) {
  if (err instanceof ReceiptOcrError) return err;
  const text = String(err?.message || err || '');
  if (/network|fetch|importScripts|Failed to load|404/i.test(text)) return fail('assets', '辨識元件載入失敗，請重新整理頁面後再試；收據照片不會被上傳。');
  if (/memory|OOM|abort\(/i.test(text)) return fail('memory', '裝置記憶體不足，請裁切或縮小照片後再試。');
  return fail('failed', '收據辨識失敗，請換一張較清晰的照片，或直接手動輸入。');
}

export async function recognizeReceipt(file, {onProgress, signal} = {}) {
  if (signal?.aborted) throw fail('aborted', '已取消辨識。');
  if (!(file instanceof Blob)) throw fail('type', '請選擇一張收據照片。');
  let last = 0, finished = false, timer = null, onAbort = null, tracked = null, worker = null, rejectFailure = null;
  const report = (progress, status) => {
    if (finished || typeof onProgress !== 'function') return;
    last = Math.max(last, Math.min(1, Math.max(0, progress)));
    try { onProgress({progress: last, status}); } catch {}
  };
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(fail('aborted', '已取消辨識。'));
    signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => reject(fail('timeout', `辨識超過 ${OCR_TIMEOUT_MS / 1000} 秒已自動停止，請裁切成只有收據的範圍或手動輸入。`)), OCR_TIMEOUT_MS);
  });
  stopped.catch(() => {});
  // tesseract.js swallows load/initialize rejections (createWorker never settles), so surface them here.
  const failed = new Promise((_, reject) => { rejectFailure = err => reject(describeFailure(err)); });
  failed.catch(() => {});

  const run = async () => {
    report(0, '正在檢查照片');
    if (file.size > MAX_RECEIPT_BYTES) throw fail('tooLarge', '照片超過 10 MB，請壓縮或裁切後再試。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const {type} = validateReceiptBytes(bytes, file.type);
    const receiptId = await sha256Hex(bytes);
    report(0.02, '正在準備圖片');
    const image = await normalizeImage(new Blob([bytes], {type}));
    if (finished) return null;
    report(0.05, '正在載入辨識核心');
    const {createWorker} = (await import('tesseract.js/dist/tesseract.esm.min.js')).default;
    if (finished) return null;
    tracked = spawnTracked(createWorker, {
      workerPath: absolute(OCR_ASSETS.workerPath),
      corePath: absolute(OCR_ASSETS.corePath),
      langPath: absolute(OCR_ASSETS.langPath),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: m => {
        const stage = STAGES[m?.status];
        if (stage) report(stage[0] + stage[1] * (Number(m.progress) || 0), stage[2]);
      },
      errorHandler: data => rejectFailure(data),
    }, event => rejectFailure(event?.message || 'Failed to load OCR worker'));
    worker = await tracked.pending;
    if (finished) return null;
    await worker.setParameters({tessedit_pageseg_mode: '4', preserve_interword_spaces: '1', user_defined_dpi: '300'});
    const {data} = await worker.recognize(image);
    const text = typeof data?.text === 'string' ? data.text.replace(/\r\n?/g, '\n').trim() : '';
    const confidence = Number.isFinite(data?.confidence) ? Math.round(Math.max(0, Math.min(100, data.confidence))) : 0;
    report(1, '辨識完成');
    return {text, confidence, receiptId};
  };

  try {
    return await Promise.race([run().catch(err => { throw describeFailure(err); }), stopped, failed]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    tracked?.kill();
    if (worker) worker.terminate().catch(() => {});
  }
}
