// Receipt image checks shared by the browser AI client and the server. Moved unchanged from the removed browser OCR module.
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_RECEIPT_PIXELS = 20000000;

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
