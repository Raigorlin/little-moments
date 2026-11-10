// Feature: jenkins-cicd-deploy, Property 46: 轉送標頭只採信 Trusted_Proxies
// **Validates: Requirements 9.8, 9.12, 10.1, 10.5**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { ipInCidrs, parseCidrList, resolveClient } from '../server/config.js';

const RUNS = { numRuns: 200 };

// ---------------------------------------------------------------------------
// 參考實作：直接以位元組陣列逐位元比對前綴（不依賴 config.js 的任何解析邏輯）

const bit = (bytes, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;
function refPrefixMatch(a, b, prefix) {
  for (let i = 0; i < prefix; i++) if (bit(a, i) !== bit(b, i)) return false;
  return true;
}
const mappedOf = v4 => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4];
const isMapped = b => b.length === 16 && b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** ip: {family, bytes}；cidrs: [{family, bytes, prefix}]。IPv4 與 IPv4-mapped IPv6 互相比對。 */
function refInCidrs(ip, cidrs) {
  const candidates = [ip];
  if (ip.family === 6 && isMapped(ip.bytes)) candidates.push({ family: 4, bytes: ip.bytes.slice(12) });
  if (ip.family === 4) candidates.push({ family: 6, bytes: mappedOf(ip.bytes) });
  return cidrs.some(c => candidates.some(x => x.family === c.family && refPrefixMatch(x.bytes, c.bytes, c.prefix)));
}

// ---------------------------------------------------------------------------
// 位址格式化（產生多種合法文字表示）

const dotted = b => b.join('.');
function v6Groups(b) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
  return g;
}
function formatV6(bytes, style) {
  const groups = v6Groups(bytes);
  if (style === 'full') return groups.map(x => x.toString(16).padStart(4, '0')).join(':');
  if (style === 'upper') return groups.map(x => x.toString(16).toUpperCase()).join(':');
  // compressed：壓縮最長（≥ 2）的連續 0 群組
  let best = -1, len = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > len && j - i >= 2) { best = i; len = j - i; }
    i = j;
  }
  const hex = groups.map(x => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + len).join(':')}`;
}

// ---------------------------------------------------------------------------
// 產生器

const byteArb = fc.integer({ min: 0, max: 255 });
const v4BytesArb = fc.array(byteArb, { minLength: 4, maxLength: 4 });
const v6BytesArb = fc.oneof(
  fc.array(byteArb, { minLength: 16, maxLength: 16 }),
  // 含大量 0 的位址，觸發 :: 壓縮與 ::1 之類的特殊形式
  fc.array(fc.oneof(fc.constant(0), byteArb), { minLength: 16, maxLength: 16 }),
);
const v6StyleArb = fc.constantFrom('full', 'upper', 'compressed');

/** {text, family, bytes}：IPv4、IPv6（多種格式）、IPv4-mapped IPv6 */
const ipArb = fc.oneof(
  v4BytesArb.map(b => ({ text: dotted(b), family: 4, bytes: b })),
  fc.tuple(v6BytesArb, v6StyleArb).map(([b, s]) => ({ text: formatV6(b, s), family: 6, bytes: b })),
  v4BytesArb.map(b => ({ text: `::ffff:${dotted(b)}`, family: 6, bytes: mappedOf(b) })),
  fc.constant({ text: '127.0.0.1', family: 4, bytes: [127, 0, 0, 1] }),
  fc.constant({ text: '::1', family: 6, bytes: [...Array(15).fill(0), 1] }),
);

/** CIDR：前綴含 0、最大值（/32、/128）邊界與任意值；最大前綴時可省略斜線 */
const cidrArb = fc.oneof(
  fc.tuple(v4BytesArb, fc.oneof(fc.constant(0), fc.constant(32), fc.integer({ min: 0, max: 32 })), fc.boolean())
    .map(([b, p, omit]) => ({ family: 4, bytes: b, prefix: p, text: p === 32 && omit ? dotted(b) : `${dotted(b)}/${p}` })),
  fc.tuple(v6BytesArb, v6StyleArb, fc.oneof(fc.constant(0), fc.constant(128), fc.integer({ min: 0, max: 128 })), fc.boolean())
    .map(([b, s, p, omit]) => ({ family: 6, bytes: b, prefix: p, text: p === 128 && omit ? formatV6(b, s) : `${formatV6(b, s)}/${p}` })),
);
const cidrListArb = fc.array(cidrArb, { minLength: 0, maxLength: 5 });

/** 在 CIDR 範圍內隨機取一個位址（保留前綴位元、隨機化其餘位元） */
const ipInsideArb = cidr =>
  fc.array(byteArb, { minLength: cidr.bytes.length, maxLength: cidr.bytes.length }).map(rand => {
    const out = cidr.bytes.map((b, i) => {
      const keep = Math.max(0, Math.min(8, cidr.prefix - i * 8));
      const mask = keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
      return (b & mask) | (rand[i] & ~mask & 0xff);
    });
    return cidr.family === 4 ? { text: dotted(out), family: 4, bytes: out } : { text: formatV6(out, 'compressed'), family: 6, bytes: out };
  });

/** 清單 + 一個位址（一半機率取自清單內某 CIDR，使命中與未命中皆常見） */
const listAndIpArb = cidrListArb.chain(cidrs =>
  fc.tuple(fc.constant(cidrs), cidrs.length ? fc.oneof(ipArb, fc.constantFrom(...cidrs).chain(ipInsideArb)) : ipArb));

const parseList = cidrs => {
  const parsed = parseCidrList(cidrs.map(c => c.text).join(','));
  expect(parsed).not.toBeNull();
  return parsed;
};

// ---------------------------------------------------------------------------

describe('Property 46: parseCidrList 與 ipInCidrs', () => {
  test('合法清單皆被接受，ipInCidrs 與逐位元前綴比對的參考實作一致', () => {
    fc.assert(fc.property(listAndIpArb, ([cidrs, ip]) => {
      const parsed = parseList(cidrs);
      expect(parsed.length).toBe(cidrs.length);
      expect(ipInCidrs(ip.text, parsed)).toBe(refInCidrs(ip, cidrs));
    }), RUNS);
  });

  test('含空項、* 或前綴超界的清單被拒絕', () => {
    const badItemArb = fc.oneof(
      fc.constant(''),
      fc.constant('   '),
      fc.constant('*'),
      v4BytesArb.map(b => `${dotted(b)}/*`),
      fc.tuple(v4BytesArb, fc.integer({ min: 33, max: 999 })).map(([b, p]) => `${dotted(b)}/${p}`),
      fc.tuple(v6BytesArb, fc.integer({ min: 129, max: 999 })).map(([b, p]) => `${formatV6(b, 'compressed')}/${p}`),
    );
    fc.assert(fc.property(cidrListArb, badItemArb, fc.nat(), (cidrs, bad, pos) => {
      const items = cidrs.map(c => c.text);
      items.splice(pos % (items.length + 1), 0, bad);
      // 單一空白項目等同未設定（回傳 []），其餘皆須拒絕
      if (items.length === 1 && bad.trim() === '') return;
      expect(parseCidrList(items.join(','))).toBeNull();
    }), RUNS);
  });

  test('邊界：/0 涵蓋同族全部位址，/32 與 /128 只涵蓋單一位址', () => {
    fc.assert(fc.property(v4BytesArb, v4BytesArb, v6BytesArb, v6BytesArb, (a, b, c, d) => {
      expect(ipInCidrs(dotted(b), parseCidrList(`${dotted(a)}/0`))).toBe(true);
      expect(ipInCidrs(formatV6(d, 'full'), parseCidrList(`${formatV6(c, 'compressed')}/0`))).toBe(true);
      expect(ipInCidrs(dotted(b), parseCidrList(`${dotted(a)}/32`))).toBe(a.every((x, i) => x === b[i]));
      expect(ipInCidrs(formatV6(d, 'upper'), parseCidrList(`${formatV6(c, 'full')}/128`))).toBe(c.every((x, i) => x === d[i]));
      // IPv4-mapped IPv6 也落在 IPv4 /0 內
      expect(ipInCidrs(`::ffff:${dotted(b)}`, parseCidrList('0.0.0.0/0'))).toBe(true);
    }), RUNS);
  });
});

// ---------------------------------------------------------------------------
// resolveClient

const GARBAGE = ['unknown', 'not-an-ip', '999.1.1.1', '1.2.3', '*', 'localhost', '[::1', '::g', '_'];

/** XFF 項目：{text, ip|null}；含偽造 127.0.0.1、清單內代理位址、方括號 IPv6 與無效值 */
const xffEntryArb = proxies => {
  const options = [
    ipArb.map(ip => ({ text: ip.text, ip })),
    fc.constant({ text: '127.0.0.1', ip: { text: '127.0.0.1', family: 4, bytes: [127, 0, 0, 1] } }),
    fc.tuple(v6BytesArb, v6StyleArb).map(([b, s]) => ({ text: `[${formatV6(b, s)}]`, ip: { text: formatV6(b, s), family: 6, bytes: b } })),
    fc.constantFrom(...GARBAGE).map(text => ({ text, ip: null })),
  ];
  if (proxies.length) options.push(fc.constantFrom(...proxies).chain(ipInsideArb).map(ip => ({ text: ip.text, ip })));
  return fc.oneof(...options);
};

const protoArb = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom('http', 'https', 'HTTPS', ' Http ', 'ftp', 'javascript', '', 'https,http', 'wss'),
);

const scenarioArb = cidrListArb.chain(proxies => fc.record({
  proxies: fc.constant(proxies),
  tcp: proxies.length ? fc.oneof(ipArb, fc.constantFrom(...proxies).chain(ipInsideArb)) : ipArb,
  xff: fc.oneof(fc.constant(undefined), fc.array(xffEntryArb(proxies), { minLength: 0, maxLength: 5 })),
  sep: fc.constantFrom(',', ', ', ' , '),
  proto: protoArb,
  scheme: fc.constantFrom('http:', 'https:'),
  headerStyle: fc.constantFrom('Headers', 'object'),
}));

function buildHeaders({ xff, sep, proto, headerStyle }) {
  const h = {};
  if (xff !== undefined) h['X-Forwarded-For'] = xff.map(e => e.text).join(sep);
  if (proto !== undefined) h['X-Forwarded-Proto'] = proto;
  return headerStyle === 'Headers' ? new Headers(h) : h;
}

/** 依 Property 46 敘述計算預期結果 */
function expected(s) {
  if (!refInCidrs(s.tcp, s.proxies)) return { clientIp: s.tcp.text, protocol: s.scheme, viaProxy: false };
  let protocol = s.scheme;
  if (s.proto !== undefined) {
    const p = s.proto.trim().toLowerCase();
    if (p === 'http' || p === 'https') protocol = `${p}:`;
  }
  let clientIp = s.tcp.text;
  const entries = s.xff ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.ip && refInCidrs(e.ip, s.proxies)) continue;
    if (e.ip) clientIp = e.ip.text;
    break; // 第一個不在代理清單內的項目；無效時退回 TCP 來源 IP
  }
  return { clientIp, protocol, viaProxy: true };
}

describe('Property 46: resolveClient 只採信 Trusted_Proxies 的轉送標頭', () => {
  test('結果符合參考模型，且有效網址的協定與 protocol 一致', () => {
    fc.assert(fc.property(scenarioArb, s => {
      const url = new URL(`${s.scheme}//lan.example:5173/api/trips?x=1`);
      const r = resolveClient(s.tcp.text, buildHeaders(s), url, parseList(s.proxies));
      const e = expected(s);
      expect(r.viaProxy).toBe(e.viaProxy);
      expect(r.protocol).toBe(e.protocol);
      expect(r.clientIp).toBe(e.clientIp);
      expect(r.url.protocol).toBe(r.protocol);
      expect(r.url.host).toBe(url.host);
      expect(r.url.pathname + r.url.search).toBe('/api/trips?x=1');
      expect(url.protocol).toBe(s.scheme); // 不修改傳入的 URL
    }), RUNS);
  });

  test('非代理來源：結果與轉送標頭內容完全無關', () => {
    // 排除過寬前綴（/0 等）以免找不到清單外的位址；寬前綴情境已由上一個測試涵蓋
    const narrowListArb = cidrListArb.map(list => list.filter(c => c.prefix >= 8));
    const nonProxyArb = narrowListArb.chain(proxies =>
      fc.tuple(fc.constant(proxies), ipArb.filter(ip => !refInCidrs(ip, proxies)), fc.array(xffEntryArb(proxies), { maxLength: 4 }), protoArb));
    fc.assert(fc.property(nonProxyArb, ([proxies, tcp, xff, proto]) => {
      const parsed = parseList(proxies);
      const url = new URL('http://lan.example:5173/api/setup');
      const withHeaders = resolveClient(tcp.text, buildHeaders({ xff, sep: ',', proto, headerStyle: 'Headers' }), url, parsed);
      const without = resolveClient(tcp.text, new Headers(), url, parsed);
      expect(withHeaders.viaProxy).toBe(false);
      expect(withHeaders.clientIp).toBe(tcp.text);
      expect(withHeaders.protocol).toBe('http:');
      expect({ ...withHeaders, url: withHeaders.url.href }).toEqual({ ...without, url: without.url.href });
    }), RUNS);
  });

  test('範例：偽造 127.0.0.1 的 X-Forwarded-For', () => {
    const proxies = parseCidrList('172.18.0.2');
    const url = new URL('http://lan.example:5173/api/setup');
    const forged = { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' };

    // LAN 用戶端直接連線：忽略偽造標頭
    const direct = resolveClient('192.168.1.50', forged, url, proxies);
    expect(direct).toMatchObject({ clientIp: '192.168.1.50', protocol: 'http:', viaProxy: false });

    // 經代理轉送：採信標頭，但 viaProxy 為真，不可視為 loopback 用戶端
    const proxied = resolveClient('172.18.0.2', forged, url, proxies);
    expect(proxied).toMatchObject({ clientIp: '127.0.0.1', protocol: 'https:', viaProxy: true });
    expect(proxied.url.href).toBe('https://lan.example:5173/api/setup');

    // 用戶端在左側偽造，代理附加真實位址：取最右側非代理位址
    const chained = resolveClient('172.18.0.2', { 'x-forwarded-for': '127.0.0.1, 192.168.1.50' }, url, proxies);
    expect(chained.clientIp).toBe('192.168.1.50');

    // 未設定 Trusted_Proxies：一律不採信
    expect(resolveClient('127.0.0.1', forged, url, [])).toMatchObject({ clientIp: '127.0.0.1', protocol: 'http:', viaProxy: false });
  });
});
