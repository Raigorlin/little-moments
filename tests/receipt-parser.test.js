import {describe, test, expect} from 'bun:test';
import {parseReceiptText, formatAmount} from '../src/receipt-parser.js';
import {sniffImageType, readImageSize, validateReceiptBytes, planOcrSize, recognizeReceipt, MAX_RECEIPT_BYTES} from '../src/receipt-ocr.js';
import {parseAmount} from '../src/expense-model.js';

const receipt = `山野生活超市 中山門市
台北市中山區南京東路一段100號
電話 02-2345-6789
2026-11-04 10:23 交易序號 0012
電子發票證明聯 AB-12345678
統一編號 12345678
品名 數量 單價 金額
鮮 奶 2 x 45 90
吐司 55
雞蛋 4710088410128
1 X 72 72
冰塊 3 30 90
小計 307
營業稅 15
總 計 307
現金 500
找零 193
謝謝光臨`;

const byTitle = (result, title) => result.items.find(item => item.title.startsWith(title));

describe('receipt parser', () => {
  test('parses a normal Traditional Chinese receipt and skips metadata/summary lines', () => {
    const result = parseReceiptText(receipt);
    expect(result.items).toEqual([
      {lineId: 'L8', title: '鮮奶 2 × 45', amount: '90', warning: ''},
      {lineId: 'L9', title: '吐司', amount: '55', warning: ''},
      {lineId: 'L11', title: '雞蛋 1 × 72', amount: '72', warning: ''},
      {lineId: 'L12', title: '冰塊 3 × 30', amount: '90', warning: ''},
    ]);
    expect(result.totalCents).toBe(30700);
    expect(result.warnings.some(w => w.includes('第 13、14、16、17 行'))).toBe(true);
    expect(result.warnings.some(w => w.includes('不符'))).toBe(false);
    for (const item of result.items) expect(parseAmount(item.amount)).toBeGreaterThan(0);
  });

  test('never turns total, subtotal, cash, change or tax into expense items', () => {
    const result = parseReceiptText('合計 500\n小計 480\n現金 1000\n找零 500\n稅額 24\nTOTAL 500\nCASH 1000');
    expect(result.items).toEqual([]);
    expect(result.totalCents).toBe(50000);
  });

  test('line IDs are stable per source line and unique for repeated items', () => {
    const text = '可樂 35\n可樂 35';
    const first = parseReceiptText(text), second = parseReceiptText(text);
    expect(first.items.map(i => i.lineId)).toEqual(['L1', 'L2']);
    expect(second.items).toEqual(first.items);
    expect(parseReceiptText('\n\n可樂 35').items[0].lineId).toBe('L3');
  });

  test('does not guess OCR numeric noise', () => {
    const result = parseReceiptText('木炭 1O0\n烤肉醬 4S\n香腸 1,23\n玉米 12.345\n茶裏王25');
    expect(result.items.map(i => i.amount)).toEqual(['', '', '', '', '']);
    expect(result.items.map(i => i.title)).toEqual(['木炭', '烤肉醬', '香腸', '玉米', '茶裏王']);
    for (const item of result.items) expect(item.warning).toMatch(/手動輸入/);
    expect(result.items[0].warning).toContain('1O0');
  });

  test('accepts full-width digits, currency marks, thousands and two decimals strictly', () => {
    const result = parseReceiptText('帳篷 NT$1,280\n營燈 $ 499\n咖啡豆 ３２０元\n濾紙 12.5\n炭火 45TX');
    expect(result.items.map(i => i.amount)).toEqual(['1280', '499', '320', '12.50', '45']);
  });

  test('negative or keyword discounts are exposed as warnings, not items', () => {
    const result = parseReceiptText('牛排 300\n玉米 50\n會員折扣 -30\n滿額優惠 20\n加購 −10\n總計 290');
    expect(result.items.map(i => i.title)).toEqual(['牛排', '玉米']);
    const discountWarnings = result.warnings.filter(w => w.includes('折扣') && w.includes('手動修正'));
    expect(discountWarnings).toHaveLength(3);
    expect(result.warnings.some(w => w.includes('扣除折扣') && w.includes('相符'))).toBe(true);
  });

  test('preserves quantity rows and flags inconsistent arithmetic', () => {
    const result = parseReceiptText('鮮奶 2 x 45 = 90\n雞腿 @60 x 3 180\n礦泉水 x6 120\n啤酒 4 50 210\n蛤蜊 2 × 85');
    expect(result.items.map(i => [i.title, i.amount])).toEqual([
      ['鮮奶 2 × 45', '90'], ['雞腿 3 × 60', '180'], ['礦泉水 × 6', '120'], ['啤酒 4 × 50', '210'], ['蛤蜊 2 × 85', '170'],
    ]);
    expect(byTitle(result, '鮮奶').warning).toBe('');
    expect(byTitle(result, '啤酒').warning).toContain('不符');
    expect(byTitle(result, '蛤蜊').warning).toContain('計算');
  });

  test('merges a title-only line with its following quantity line', () => {
    const result = parseReceiptText('台灣高山高麗菜\n1 x 65 65');
    expect(result.items).toEqual([{lineId: 'L2', title: '台灣高山高麗菜 1 × 65', amount: '65', warning: ''}]);
  });

  test('reports a mismatch between items and the printed total', () => {
    const result = parseReceiptText('豬五花 250\n洋蔥 40\n總計 330');
    expect(result.totalCents).toBe(33000);
    const warning = result.warnings.find(w => w.includes('不符'));
    expect(warning).toContain('比總計少 NT$40');
    expect(warning).not.toContain('-NT$');
  });

  test('states the mismatch direction with an unsigned difference', () => {
    const less = parseReceiptText('CABBAGE 80\nEGGS 65\nBEEF 210\nTOTAL 395').warnings.find(w => w.includes('不符'));
    expect(less).toBe('品項合計 NT$355 與收據總計 NT$395 不符，比總計少 NT$40；可能有漏辨識、折扣或辨識錯誤，請手動檢查。');
    const more = parseReceiptText('帳篷 1,280\n睡袋 900\n總計 2,000').warnings.find(w => w.includes('不符'));
    expect(more).toContain('品項合計 NT$2,180 與收據總計 NT$2,000 不符，比總計多 NT$180');
    const discounted = parseReceiptText('牛排 300\n會員折扣 -30\n總計 200').warnings.find(w => w.includes('不符'));
    expect(discounted).toContain('扣除折扣 NT$30 後為 NT$270');
    expect(discounted).toContain('比總計多 NT$70');
  });

  test('conflicting totals are not trusted', () => {
    const result = parseReceiptText('麵包 60\n合計 60\n應付 80');
    expect(result.totalCents).toBeNull();
    expect(result.warnings.some(w => w.includes('多個不同的總計'))).toBe(true);
  });

  test('detects invoice, store, address, timestamp, phone and product-ID lines as metadata', () => {
    const result = parseReceiptText('野營補給有限公司\n新北市板橋區文化路二段10號\nTEL 02-1234-5678\n2026/11/04 18:05\n發票號碼 CD-87654321\n4710088410128\n民國115年11月04日\n收銀員 05');
    expect(result.items).toEqual([]);
    expect(result.warnings.some(w => w.includes('無法判讀'))).toBe(false);
  });

  test('exposes unknown lines and missing totals', () => {
    const result = parseReceiptText('不明文字\n香菇 80');
    expect(result.totalCents).toBeNull();
    expect(result.warnings.some(w => w.includes('第 1 行無法判讀'))).toBe(true);
    expect(result.warnings.some(w => w.includes('未辨識到收據總計'))).toBe(true);
  });

  test('rejects zero, oversized and nameless amounts for review', () => {
    const result = parseReceiptText('贈品 0\n露營車 1,000,001\n88');
    expect(result.items.map(i => i.amount)).toEqual(['', '', '88']);
    expect(result.items[2].warning).toContain('缺少品名');
  });

  test('handles empty or non-string input safely', () => {
    expect(parseReceiptText('').items).toEqual([]);
    expect(parseReceiptText(null).totalCents).toBeNull();
  });

  test('formats cents without floating point', () => {
    expect(formatAmount(1)).toBe('0.01');
    expect(formatAmount(1050)).toBe('10.50');
    expect(formatAmount(100000000)).toBe('1000000');
  });
});

const png = (w, h) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h); return b; };
const jpeg = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
const webp = (w, h) => { const b = new Uint8Array(32); b.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); b.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8); const v = new DataView(b.buffer); v.setUint32(24, (w - 1) & 0xffffff, true); v.setUint32(27, (h - 1) & 0xffffff, true); return b; };

describe('receipt OCR input checks', () => {
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

  test('plans modest resizing that keeps aspect ratio', () => {
    expect(planOcrSize(4000, 5000)).toEqual({width: 2530, height: 3162});
    expect(planOcrSize(600, 1000)).toEqual({width: 960, height: 1600});
    expect(planOcrSize(2000, 3000)).toEqual({width: 2000, height: 3000});
  });

  test('rejects already-aborted requests and non-files without loading OCR', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(recognizeReceipt(new Blob([png(1, 1)]), {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError', message: '已取消辨識。'});
    await expect(recognizeReceipt('x')).rejects.toThrow('請選擇一張收據照片');
  });
});
