// Receipt image helpers (src/receipt-image.js) and the server-side receipt AI image check (validateAiImage).
import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { sniffImageType, readImageSize, validateReceiptBytes, MAX_RECEIPT_BYTES } from '../src/receipt-image.js';
import { validateAiImage, AI_IMAGE_LIMIT } from '../server/receipt-ai.js';

// Header-only fixtures for the shared helpers (moved from tests/receipt-parser.test.js).
const png = (w, h) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h); return b; };
const jpeg = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
const webp = (w, h) => { const b = new Uint8Array(32); b.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); b.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8); const v = new DataView(b.buffer); v.setUint32(24, (w - 1) & 0xffffff, true); v.setUint32(27, (h - 1) & 0xffffff, true); return b; };

describe('receipt image helpers', () => {
  test('sniffs only JPEG, PNG and WebP bytes', () => {
    expect(sniffImageType(png(1, 1))).toBe('image/png');
    expect(sniffImageType(jpeg(1, 1))).toBe('image/jpeg');
    expect(sniffImageType(webp(1, 1))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });

  test('reads header dimensions before decoding', () => {
    expect(readImageSize(png(1200, 3400), 'image/png')).toEqual({width: 1200, height: 3400});
    expect(readImageSize(jpeg(4032, 3024), 'image/jpeg')).toEqual({width: 4032, height: 3024});
    expect(readImageSize(webp(800, 2000), 'image/webp')).toEqual({width: 800, height: 2000});
  });

  test('enforces size, type and 20-million pixel limits with Chinese messages', () => {
    expect(() => validateReceiptBytes(new Uint8Array(0))).toThrow('空檔案');
    expect(() => validateReceiptBytes(new TextEncoder().encode('not an image'))).toThrow('JPEG、PNG 或 WebP');
    expect(() => validateReceiptBytes(png(10, 10), 'image/gif')).toThrow('JPEG、PNG 或 WebP');
    expect(() => validateReceiptBytes(png(5000, 4001))).toThrow('2,000 萬像素');
    expect(() => validateReceiptBytes(new Uint8Array(MAX_RECEIPT_BYTES + 1).fill(0xff))).toThrow('10 MB');
    expect(validateReceiptBytes(jpeg(5000, 4000), 'image/jpeg').type).toBe('image/jpeg');
  });
});

// Complete image builders for Property 21. Payload bytes stay below 0x49 ('I') and never equal 0xff,
// so no truncation of a complete image can end in a JPEG EOI marker or place 'IEND' at the PNG check position.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = s => [...s].map(c => c.charCodeAt(0));
const chunk = (type, data) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const completePng = (w, h, data) => Uint8Array.from([
  ...PNG_SIG,
  ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]),
  ...(data.length ? chunk('IDAT', data) : []),
  ...chunk('IEND', [])
]);
const completeJpeg = (w, h, data) => Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xe0, 0, 4, 0, 0,
  0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0,
  ...data,
  0xff, 0xd9
]);

const payload = fc.uint8Array({ maxLength: 64, max: 0x40 });
// Dimensions within 8000 px per side and 20,000,000 px.
const dims = fc.tuple(fc.integer({ min: 1, max: 8000 }), fc.integer({ min: 1, max: 8000 })).filter(([w, h]) => w * h <= 20000000);
const format = fc.constantFrom('png', 'jpeg');
const build = (fmt, [w, h], data) => (fmt === 'png' ? completePng : completeJpeg)(w, h, data);
const typeOf = fmt => `image/${fmt}`;
const statusOf = fn => { try { fn(); return 'accepted'; } catch (error) { return error.status; } };
const REJECTED = [400, 413, 415];

describe('receipt AI image validation', () => {
  // Feature: security-hardening, Property 21: Receipt image validation accepts exactly complete images
  // **Validates: Requirements 17.1, 17.2, 17.4, 17.5**
  test('Property 21: receipt image validation accepts exactly complete images', () => {
    const accepted = fc.record({ kind: fc.constant('complete'), fmt: format, size: dims, data: payload });
    const empty = fc.record({ kind: fc.constant('empty'), fmt: format });
    const randomTail = fc.record({ kind: fc.constant('randomTail'), fmt: format, tail: fc.uint8Array({ minLength: 0, maxLength: 128 }) });
    const truncated = fc.record({ kind: fc.constant('truncated'), fmt: format, size: dims, data: payload, cut: fc.nat() });
    const mismatched = fc.record({
      kind: fc.constant('mismatched'), fmt: format, size: dims, data: payload,
      declared: fc.constantFrom('', 'image/webp', 'image/gif', 'text/plain', 'application/octet-stream', 'IMAGE/PNG', 'image/jpg')
    });
    const oversized = fc.record({
      kind: fc.constant('oversized'), fmt: format, data: payload,
      size: fc.oneof(
        fc.tuple(fc.integer({ min: 8001, max: 65535 }), fc.integer({ min: 1, max: 65535 })),
        fc.tuple(fc.integer({ min: 1, max: 65535 }), fc.integer({ min: 8001, max: 65535 })),
        fc.tuple(fc.integer({ min: 2501, max: 8000 }), fc.integer({ min: 2501, max: 8000 })).filter(([w, h]) => w * h > 20000000),
        fc.constant([0, 10]), fc.constant([10, 0])
      )
    });

    fc.assert(fc.property(fc.oneof(accepted, empty, randomTail, truncated, mismatched, oversized), c => {
      if (c.kind === 'complete') {
        const bytes = build(c.fmt, c.size, c.data);
        const result = validateAiImage(bytes, typeOf(c.fmt));
        expect(result).toEqual({ format: c.fmt, width: c.size[0], height: c.size[1] });
        return;
      }
      let bytes, declared = typeOf(c.fmt);
      if (c.kind === 'empty') bytes = new Uint8Array(0);
      if (c.kind === 'randomTail') {
        const sig = c.fmt === 'png' ? PNG_SIG : [0xff, 0xd8, 0xff];
        bytes = Uint8Array.from([...sig, ...c.tail]);
        // Keep the random tail from forming a complete image by chance.
        if (c.fmt === 'jpeg') bytes[bytes.length - 1] = 0x00;
        else if (bytes.length >= 8) bytes[bytes.length - 8] = 0x00;
      }
      if (c.kind === 'truncated') {
        const full = build(c.fmt, c.size, c.data);
        bytes = full.subarray(0, c.cut % full.length);
      }
      if (c.kind === 'mismatched') { bytes = build(c.fmt, c.size, c.data); declared = c.declared; }
      if (c.kind === 'oversized') bytes = build(c.fmt, c.size, c.data);
      expect(REJECTED).toContain(statusOf(() => validateAiImage(bytes, declared)));
    }), { numRuns: 300 });
  });

  test('a JPEG declared as PNG and a PNG declared as JPEG get 415', () => {
    expect(statusOf(() => validateAiImage(completeJpeg(10, 10, []), 'image/png'))).toBe(415);
    expect(statusOf(() => validateAiImage(completePng(10, 10, []), 'image/jpeg'))).toBe(415);
  });

  test('size boundary: exactly 3.5 MiB passes the size check, one byte more is 413', () => {
    const exact = new Uint8Array(AI_IMAGE_LIMIT).fill(0x20);
    exact.set(completeJpeg(100, 100, []).subarray(0, 21));
    exact.set([0xff, 0xd9], exact.length - 2);
    expect(validateAiImage(exact, 'image/jpeg')).toEqual({ format: 'jpeg', width: 100, height: 100 });
    const over = new Uint8Array(AI_IMAGE_LIMIT + 1);
    over.set(exact);
    over.set([0xff, 0xd9], over.length - 2);
    expect(statusOf(() => validateAiImage(over, 'image/jpeg'))).toBe(413);
  });

  test('dimension boundaries: 8000 px per side and 20,000,000 px', () => {
    expect(validateAiImage(completePng(8000, 2500, []), 'image/png').width).toBe(8000);
    expect(statusOf(() => validateAiImage(completePng(8001, 1, []), 'image/png'))).toBe(400);
    expect(statusOf(() => validateAiImage(completeJpeg(1, 8001, []), 'image/jpeg'))).toBe(400);
    expect(statusOf(() => validateAiImage(completePng(5000, 4001, []), 'image/png'))).toBe(400);
  });
});
