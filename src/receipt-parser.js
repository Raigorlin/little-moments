const MAX_CENTS = 100000000;
const MAX_TITLE = 100;
const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
const MULT = '[xX×*]';

const TOTAL = /(?:總\s*計|合\s*計|總\s*額|總金額|應\s*付|應\s*收|實\s*付|消費金額|\bTOTAL\b|AMOUNT\s*DUE)/i;
const SUBTOTAL = /(?:小\s*計|SUB\s*-?TOTAL)/i;
const DISCOUNT = /(?:折\s*扣|折\s*價|折\s*讓|折\s*抵|優\s*惠|特價折|DISCOUNT|COUPON)/i;
const TAX = /(?:營業稅|稅\s*額|未稅|含稅|應稅|免稅|稅\s*金|\bTAX\b)/i;
const PAYMENT = /(?:現\s*金|收\s*現|實\s*收|找\s*零|找\s*錢|付\s*款|信用卡|刷\s*卡|悠遊卡|一卡通|LINE\s*PAY|街口|Apple\s*Pay|\bCASH\b|\bCHANGE\b|\bVISA\b)/i;
const METADATA = /(?:發\s*票|統一編號|統\s*編|賣\s*方|買\s*方|載\s*具|隨機碼|證明聯|收銀|機\s*台|機\s*號|POS|單\s*號|序\s*號|交易|卡\s*號|會員編號|品\s*號|貨\s*號|條\s*碼|編\s*號|電\s*話|TEL\b|FAX|網\s*址|https?:|www\.|謝謝|歡迎|光臨|退換貨|營業時間|共\s*\d+\s*[項件]|品項數|件\s*數)/i;
const STORE = /(?:股份有限公司|有限公司|門\s*市|分\s*店|商\s*行|超\s*市|超\s*商|量\s*販|便利商店|百\s*貨)/;
const ADDRESS = /(?:[縣市].{0,8}[區鄉鎮市].{0,12}(?:路|街|大道)|(?:路|街|大道|巷|弄).{0,12}\d+\s*號)/;
const TIMESTAMP = /(?:\b(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|民國\s*\d{2,3}\s*年|\b\d{2,3}\s*年\s*\d{1,2}\s*月|\b\d{1,2}:\d{2}(?::\d{2})?\b)/;
const INVOICE_NO = /\b[A-Z]{2}\s*-?\s*\d{8}\b/;
const PHONE = /\b0\d{1,2}\s*-\s*\d{3,4}\s*-?\s*\d{3,4}\b/;
const COLUMN_HEADER = /^(?:品\s*名|品\s*項|商\s*品|名\s*稱|項\s*目)(?:.*(?:數\s*量|單\s*價|金\s*額|小\s*計))+$/;
const SEPARATOR = /^[\s\-_=*#~.·•:|/\\]+$/;

const PRICE_TOKEN = /^(-)?(?:NT\$|\$)?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:元)?(?:TX)?$/;
const NOISY_TOKEN = /^-?(?:NT\$|\$)?[\dOoIlSBZ|.,]*\d[\dOoIlSBZ|.,]*(?:元)?$/;
const GLUED = new RegExp(`[${CJK}A-Za-z](\\d+(?:\\.\\d{1,2})?)$`);

function normalizeLine(raw) {
  return raw.normalize('NFKC')
    .replace(/[\u2212\u2012\u2013\u2014\u2015\uFE63]/g, '-')
    .replace(/\t/g, ' ')
    .replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g'), '')
    .replace(/\s*=\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function centsFromParts(whole, fraction = '') {
  const digits = whole.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  if (digits.length > 7) return null;
  return Number(digits) * 100 + Number(fraction.padEnd(2, '0'));
}

function parsePriceToken(token) {
  const m = PRICE_TOKEN.exec(token);
  if (!m) return null;
  const cents = centsFromParts(m[3], m[4]);
  if (cents === null) return {error: 'tooLarge'};
  return {cents: m[1] || m[2] ? -cents : cents};
}

export function formatAmount(cents) {
  const whole = Math.floor(cents / 100), rest = cents % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0')}` : String(whole);
}

const money = cents => `${cents < 0 ? '-' : ''}NT$${formatAmount(Math.abs(cents)).replace(/^\d+/, whole => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','))}`;
const clip = text => (text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) : text);
const quote = text => `「${text.length > 30 ? `${text.slice(0, 30)}…` : text}」`;

function splitTrailing(line) {
  const tokens = line.split(' ').filter(Boolean);
  while (tokens.length > 1 && /^(?:元|TX|NT\$|\$)$/.test(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return {kind: 'none', prefix: ''};
  const last = tokens[tokens.length - 1];
  let rest = tokens.slice(0, -1);
  if (rest.length && /^(?:NT\$|\$|-)$/.test(rest[rest.length - 1])) {
    const sign = rest[rest.length - 1] === '-' ? '-' : '';
    rest = rest.slice(0, -1);
    const price = parsePriceToken(sign + last);
    if (price) return {kind: 'price', price, token: sign + last, prefix: rest.join(' ')};
  }
  const price = parsePriceToken(last);
  if (price) return {kind: 'price', price, token: last, prefix: rest.join(' ')};
  if (NOISY_TOKEN.test(last) && /\d/.test(last)) return {kind: 'noise', token: last, prefix: rest.join(' ')};
  const glued = GLUED.exec(last);
  if (glued) return {kind: 'glued', token: glued[1], prefix: line};
  return {kind: 'none', prefix: line};
}

function stripProductCodes(text) {
  return text.split(' ').filter(token => !/^\d{8,14}$/.test(token)).join(' ').trim();
}

const QTY_UNIT = new RegExp(`^(.*?)\\s*(?:^|\\s)(\\d{1,3})\\s*${MULT}\\s*@?\\s*(\\d+(?:\\.\\d{1,2})?)$`);
const UNIT_QTY = new RegExp(`^(.*?)\\s*(?:^|\\s)@\\s*(\\d+(?:\\.\\d{1,2})?)\\s*${MULT}\\s*(\\d{1,3})$`);
const X_QTY = new RegExp(`^(.*?)\\s*(?:^|\\s)${MULT}\\s*(\\d{1,3})$`);
const QTY_X = new RegExp(`^(.*?)\\s*(?:^|\\s)(\\d{1,3})\\s*${MULT}$`);
const COLUMNS = /^(.*?)\s*(?:^|\s)(\d{1,3})\s+(\d+(?:\.\d{1,2})?)$/;

const unitCents = text => { const [w, f = ''] = text.split('.'); return centsFromParts(w, f); };

function readQuantity(prefix, cents) {
  let m = UNIT_QTY.exec(prefix);
  if (m) return {name: m[1], qty: Number(m[3]), unit: unitCents(m[2]), line: cents};
  if ((m = QTY_UNIT.exec(prefix))) return {name: m[1], qty: Number(m[2]), unit: unitCents(m[3]), line: cents};
  if ((m = COLUMNS.exec(prefix)) && Number(m[2]) > 0) {
    const qty = Number(m[2]), unit = unitCents(m[3]);
    if (qty * unit === cents) return {name: m[1], qty, unit, line: cents};
    return {name: m[1], qty, unit, line: cents, columns: true};
  }
  if ((m = X_QTY.exec(prefix))) return {name: m[1], qty: Number(m[2]), unit: null, line: cents};
  if ((m = QTY_X.exec(prefix))) return {name: m[1], qty: Number(m[2]), unit: cents, line: null};
  return null;
}

function classify(line) {
  if (!line || SEPARATOR.test(line)) return 'blank';
  if (COLUMN_HEADER.test(line)) return 'header';
  if (DISCOUNT.test(line)) return 'discount';
  if (SUBTOTAL.test(line)) return 'subtotal';
  if (TOTAL.test(line)) return 'total';
  if (TAX.test(line)) return 'tax';
  if (PAYMENT.test(line)) return 'payment';
  if (METADATA.test(line) || STORE.test(line) || INVOICE_NO.test(line) || PHONE.test(line) || TIMESTAMP.test(line) || ADDRESS.test(line)) return 'metadata';
  if (/^\d{8,14}$/.test(line.replace(/\s/g, ''))) return 'metadata';
  return 'body';
}

export function parseReceiptText(text) {
  const items = [], warnings = [];
  const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').split('\n') : [];
  const skipped = [], unknown = [], discounts = [], totals = [];
  let pending = null;

  const lineId = index => `L${index + 1}`;
  const flushPending = () => { if (pending) unknown.push(pending); pending = null; };

  source.forEach((raw, index) => {
    const line = normalizeLine(raw);
    const number = index + 1;
    const kind = classify(line);
    if (kind === 'blank' || kind === 'header') return;
    if (kind === 'metadata') { flushPending(); return; }

    const trailing = splitTrailing(kind === 'body' ? stripProductCodes(line) : line);
    if (kind === 'discount' || (kind === 'body' && trailing.kind === 'price' && trailing.price.cents < 0)) {
      flushPending();
      if (trailing.kind === 'price' && !trailing.price.error) discounts.push({number, text: line, cents: Math.abs(trailing.price.cents)});
      else warnings.push(`第 ${number} 行看起來是折扣 ${quote(line)}，但金額無法確認，請手動修正相關品項金額。`);
      return;
    }
    if (kind === 'total') {
      flushPending();
      if (trailing.kind === 'price' && !trailing.price.error && trailing.price.cents > 0) totals.push({number, cents: trailing.price.cents});
      else warnings.push(`第 ${number} 行看起來是總計 ${quote(line)}，但金額無法確認，未用於核對。`);
      return;
    }
    if (kind !== 'body') { flushPending(); skipped.push(number); return; }

    if (trailing.kind === 'none') {
      const title = stripProductCodes(line);
      flushPending();
      if (title) pending = {number, text: title};
      return;
    }

    const prefix = trailing.kind === 'glued' ? '' : trailing.prefix;
    if (trailing.kind === 'noise' || trailing.kind === 'glued') {
      const title = trailing.kind === 'glued' ? trailing.prefix.slice(0, -trailing.token.length) : prefix;
      const merged = !title && pending ? pending.text : title;
      if (!title && pending) pending = null; else flushPending();
      items.push({
        lineId: lineId(index), title: clip(merged), amount: '',
        warning: trailing.kind === 'noise'
          ? `金額疑似辨識錯誤（${trailing.token}），未自動判讀，請對照收據手動輸入。`
          : `金額與品名相連（可能是 ${trailing.token}），請確認品名與金額後手動輸入。`,
      });
      return;
    }

    const {price} = trailing;
    const notes = [];
    let title = prefix, cents = price.error ? null : price.cents;
    if (price.error) notes.push(`金額 ${trailing.token} 超過單筆上限 NT$1,000,000，請手動確認。`);
    const qty = cents === null ? null : readQuantity(prefix, cents);
    if (qty) {
      const name = qty.name.trim();
      if (qty.line === null) {
        cents = qty.qty * qty.unit;
        title = `${name} ${qty.qty} × ${formatAmount(qty.unit)}`.trim();
        notes.push(`未看到此列小計，金額依數量 ${qty.qty} × 單價 ${formatAmount(qty.unit)} 計算，請確認。`);
      } else if (qty.unit === null) {
        title = `${name} × ${qty.qty}`.trim();
      } else {
        title = `${name} ${qty.qty} × ${formatAmount(qty.unit)}`.trim();
        if (qty.qty * qty.unit !== qty.line) notes.push(`數量 × 單價（${qty.qty} × ${formatAmount(qty.unit)} = ${formatAmount(qty.qty * qty.unit)}）與金額 ${formatAmount(qty.line)} 不符，請確認。`);
      }
    }
    const nameOnly = qty ? qty.name.trim() : prefix;
    if (!nameOnly && pending) { title = `${pending.text} ${title}`.trim(); pending = null; }
    else flushPending();
    if (!nameOnly && !title.replace(/[\d\s×.]/g, '')) notes.push('缺少品名，請手動輸入。');
    if (cents === 0) { notes.push('金額為 0，請確認是否需要列入。'); cents = null; }
    if (cents !== null && cents > MAX_CENTS) { notes.push('金額超過單筆上限 NT$1,000,000，請手動確認。'); cents = null; }
    items.push({lineId: lineId(index), title: clip(title), amount: cents === null ? '' : formatAmount(cents), warning: notes.join(' ')});
  });
  flushPending();

  let totalCents = null;
  const distinctTotals = [...new Set(totals.map(t => t.cents))];
  if (distinctTotals.length === 1) totalCents = distinctTotals[0];
  else if (distinctTotals.length > 1) warnings.push(`收據上有多個不同的總計（${totals.map(t => `第 ${t.number} 行 ${money(t.cents)}`).join('、')}），請手動確認。`);

  for (const d of discounts) warnings.push(`第 ${d.number} 行為折扣 ${quote(d.text)}（-${money(d.cents)}），未自動扣除；請手動修正相關品項金額。`);
  if (skipped.length) warnings.push(`已略過第 ${skipped.join('、')} 行的小計／稅額／付款／找零資訊，這些不會列為支出。`);
  for (const u of unknown) warnings.push(`第 ${u.number} 行無法判讀為品項：${quote(u.text)}，如有需要請手動新增。`);

  const priced = items.filter(item => item.amount);
  const sum = priced.reduce((acc, item) => acc + unitCents(item.amount), 0);
  const discountCents = discounts.reduce((acc, d) => acc + d.cents, 0);
  const missing = items.length - priced.length;
  if (totalCents !== null) {
    if (missing) warnings.push(`有 ${missing} 個品項金額待確認，暫時無法與總計 ${money(totalCents)} 核對。`);
    else if (sum === totalCents) { if (discountCents) warnings.push(`品項金額已等於總計 ${money(totalCents)}，折扣可能已含在品項中，請勿重複扣除。`); }
    else if (discountCents && sum - discountCents === totalCents) warnings.push(`品項合計 ${money(sum)} 扣除折扣 ${money(discountCents)} 後與總計 ${money(totalCents)} 相符；請把折扣分配到相關品項後再確認。`);
    else {
      const net = sum - discountCents, diff = net - totalCents;
      warnings.push(`品項合計 ${money(sum)}${discountCents ? `（扣除折扣 ${money(discountCents)} 後為 ${money(net)}）` : ''} 與收據總計 ${money(totalCents)} 不符，比總計${diff < 0 ? '少' : '多'} ${money(Math.abs(diff))}；可能有漏辨識、折扣或辨識錯誤，請手動檢查。`);
    }
  } else if (items.length) warnings.push('未辨識到收據總計，無法自動核對金額，請逐筆確認。');
  if (!items.length) warnings.push('沒有找到可用的品項金額，請編輯辨識文字或手動新增支出。');

  return {items, totalCents, warnings};
}
