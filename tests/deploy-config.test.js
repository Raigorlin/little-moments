import { test, expect, describe } from 'bun:test';
import fc from 'fast-check';
import {
  ConfigError,
  ENV,
  LOCAL_DEFAULTS,
  normalizeIp,
  parseDeploymentConfig,
  selectClientAddress,
  isHostAllowed,
  resolveRequestContext,
  formatStartupLines
} from '../server/deploy-config.js';
import { createHttpHandler } from '../server/http.js';

const ORIGIN = 'https://www.our-littlemoments.com';
const PUBLISHED = { CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: ORIGIN };

function expectConfigError(env, setting, pattern) {
  let error;
  try { parseDeploymentConfig(env); } catch (err) { error = err; }
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.setting).toBe(setting);
  expect(error.message).toContain(setting);
  if (pattern) expect(error.message).toMatch(pattern);
}

describe('parseDeploymentConfig: valid configurations', () => {
  test('empty environment equals LOCAL_DEFAULTS with today\'s behavior', () => {
    const config = parseDeploymentConfig({});
    expect(config).toEqual(LOCAL_DEFAULTS);
    expect(config).toEqual({
      published: false,
      publicOrigin: null,
      publicHostname: null,
      bindHost: '127.0.0.1',
      port: 5173,
      trustedProxies: [],
      localExtraHosts: [],
      nonLoopbackBindOptIn: false,
      dockerLocalOnly: false,
      registrationPolicy: 'open',
      receiptAiPolicySeed: null
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('Published_Mode for https://www.our-littlemoments.com', () => {
    const config = parseDeploymentConfig(PUBLISHED);
    expect(config).toEqual({
      published: true,
      publicOrigin: ORIGIN,
      publicHostname: 'www.our-littlemoments.com',
      bindHost: '127.0.0.1',
      port: 5173,
      trustedProxies: ['127.0.0.1', '::1'],
      localExtraHosts: [],
      nonLoopbackBindOptIn: false,
      dockerLocalOnly: false,
      registrationPolicy: 'closed',
      receiptAiPolicySeed: null
    });
  });

  test('Published_Mode normalizes the origin and accepts explicit closed registration', () => {
    const config = parseDeploymentConfig({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: 'HTTPS://WWW.Our-LittleMoments.com/', CAMPING_REGISTRATION: 'closed', CAMPING_RECEIPT_AI_POLICY: 'admins' });
    expect(config.publicOrigin).toBe(ORIGIN);
    expect(config.registrationPolicy).toBe('closed');
    expect(config.receiptAiPolicySeed).toBe('admins');
  });

  test('a non-loopback bind is accepted with the explicit opt-in or Docker_Local_Only', () => {
    expect(parseDeploymentConfig({ HOST: '0.0.0.0', CAMPING_ALLOW_NON_LOOPBACK_BIND: '1' }).nonLoopbackBindOptIn).toBe(true);
    const docker = parseDeploymentConfig({ HOST: '0.0.0.0', CAMPING_DOCKER_LOCAL_ONLY: '1' });
    expect(docker.dockerLocalOnly).toBe(true);
    expect(docker.nonLoopbackBindOptIn).toBe(true);
  });
});

describe('parseDeploymentConfig: each Requirement 2 rejection', () => {
  test('2.1 Published_Mode without a public origin', () => {
    expectConfigError({ CAMPING_PUBLISHED: '1' }, ENV.publicOrigin, /required/);
  });

  test('2.2 Published_Mode with an http: origin', () => {
    expectConfigError({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: 'http://www.our-littlemoments.com' }, ENV.publicOrigin, /https:/);
  });

  test('2.3 origin with a path, query, fragment, or credentials', () => {
    expectConfigError({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: `${ORIGIN}/app` }, ENV.publicOrigin, /path/);
    expectConfigError({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: `${ORIGIN}?x=1` }, ENV.publicOrigin, /query or fragment/);
    expectConfigError({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: `${ORIGIN}#top` }, ENV.publicOrigin, /query or fragment/);
    expectConfigError({ ...PUBLISHED, CAMPING_PUBLIC_ORIGIN: 'https://user:pw@www.our-littlemoments.com' }, ENV.publicOrigin, /credentials/);
  });

  test('2.4 non-loopback bind host without the opt-in', () => {
    expectConfigError({ HOST: '0.0.0.0' }, ENV.host, new RegExp(ENV.allowNonLoopbackBind));
    expectConfigError({ HOST: '192.168.1.10' }, ENV.host, new RegExp(ENV.allowNonLoopbackBind));
  });

  test('2.5 Published_Mode with Docker_Local_Only', () => {
    expectConfigError({ ...PUBLISHED, CAMPING_DOCKER_LOCAL_ONLY: '1' }, ENV.dockerLocalOnly, /cannot be combined/);
  });

  test('2.6 invalid trusted proxy entry', () => {
    expectConfigError({ CAMPING_TRUSTED_PROXIES: '127.0.0.1, nginx.local' }, ENV.trustedProxies, /"nginx\.local"/);
  });

  test('2.7 registration policy and receipt AI seed outside their values', () => {
    expectConfigError({ CAMPING_REGISTRATION: 'invite' }, ENV.registration, /Accepted values: open, closed/);
    expectConfigError({ CAMPING_RECEIPT_AI_POLICY: 'members' }, ENV.receiptAiPolicy, /Accepted values: all, admins, off/);
  });

  test('2.8 invalid local extra host entry', () => {
    expectConfigError({ CAMPING_LOCAL_EXTRA_HOSTS: 'camp.lan, bad_host!' }, ENV.localExtraHosts, /"bad_host!"/);
  });

  test('2.9 Published_Mode with local extra hosts', () => {
    expectConfigError({ ...PUBLISHED, CAMPING_LOCAL_EXTRA_HOSTS: 'camp.lan' }, ENV.localExtraHosts, /only to Local_Mode/);
  });

  test('2.10 Boolean_Setting with a value other than 1 or 0', () => {
    expectConfigError({ CAMPING_PUBLISHED: 'true' }, ENV.published, /Accepted values: 1, 0/);
    expectConfigError({ CAMPING_ALLOW_NON_LOOPBACK_BIND: 'yes' }, ENV.allowNonLoopbackBind, /Accepted values: 1, 0/);
  });

  test('2.12 / 13.18 CAMPING_REGISTRATION=open with CAMPING_PUBLISHED=1', () => {
    expectConfigError({ ...PUBLISHED, CAMPING_REGISTRATION: 'open' }, ENV.registration, /registration is locked/);
  });
});

describe('client address selection', () => {
  const trusted = ['127.0.0.1', '::1'];

  test('trusted peer uses the forwarded client address', () => {
    expect(selectClientAddress({ peer: '127.0.0.1', xff: '203.0.113.5', trusted })).toEqual({ address: '203.0.113.5', proxied: true });
    expect(selectClientAddress({ peer: '::ffff:127.0.0.1', xff: '203.0.113.5', trusted })).toEqual({ address: '203.0.113.5', proxied: true });
  });

  test('untrusted peer with spoofed forwarding headers keeps the peer address', () => {
    expect(selectClientAddress({ peer: '198.51.100.7', xff: '10.0.0.1', trusted })).toEqual({ address: '198.51.100.7', proxied: false });
    const config = parseDeploymentConfig(PUBLISHED);
    const result = resolveRequestContext({
      url: `http://www.our-littlemoments.com/api/login`,
      headers: new Headers({ 'x-forwarded-for': '10.0.0.1', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }),
      peer: '198.51.100.7',
      config
    });
    expect(result.ok).toBe(true);
    expect(result.ctx.clientAddress).toBe('198.51.100.7');
    expect(result.ctx.isProxied).toBe(false);
    expect(result.ctx.expectedOrigin).toBe('http://www.our-littlemoments.com');
    expect(result.ctx.secureCookie).toBe(false);
  });

  test('multiple X-Forwarded-For entries select the right-most untrusted entry', () => {
    expect(selectClientAddress({ peer: '127.0.0.1', xff: '1.1.1.1, 203.0.113.5, 127.0.0.1', trusted })).toEqual({ address: '203.0.113.5', proxied: true });
    expect(selectClientAddress({ peer: '127.0.0.1', xff: '::1, 127.0.0.1', trusted })).toEqual({ address: '::1', proxied: true });
  });

  test('an invalid selected entry is rejected with 400', () => {
    expect(selectClientAddress({ peer: '127.0.0.1', xff: '203.0.113.5, not-an-ip', trusted })).toEqual({ error: 'invalid-forwarded-for' });
    const config = parseDeploymentConfig(PUBLISHED);
    const result = resolveRequestContext({
      url: `http://www.our-littlemoments.com/api/session`,
      headers: new Headers({ 'x-forwarded-for': 'not-an-ip' }),
      peer: '127.0.0.1',
      config
    });
    expect(result).toEqual({ ok: false, status: 400, message: 'Bad forwarding header' });
  });

  test('proxied request in Published_Mode uses the public origin and Secure cookies', () => {
    const config = parseDeploymentConfig(PUBLISHED);
    const result = resolveRequestContext({
      url: `http://www.our-littlemoments.com/api/login`,
      headers: new Headers({ 'x-forwarded-for': '203.0.113.5', 'x-forwarded-proto': 'http' }),
      peer: '127.0.0.1',
      config
    });
    expect(result.ok).toBe(true);
    expect(result.ctx).toMatchObject({ clientAddress: '203.0.113.5', isProxied: true, isDirectLocal: false, expectedOrigin: ORIGIN, secureCookie: true });
  });
});

describe('formatStartupLines', () => {
  test('Published_Mode lines name origin, bind address, registration, and receipt AI policy', () => {
    const config = parseDeploymentConfig(PUBLISHED);
    expect(formatStartupLines(config, { value: 'admins', source: 'stored' })).toEqual([
      `Camping accounts ready: ${ORIGIN} (app listening on http://127.0.0.1:5173)`,
      'Registration: closed (trip invitation links only). Receipt AI policy: admins (admin setting).'
    ]);
    expect(formatStartupLines(config, { value: 'off', source: 'seed' })[1]).toContain('Receipt AI policy: off (from CAMPING_RECEIPT_AI_POLICY)');
    expect(formatStartupLines({ ...config, bindHost: '::1' }, 'all')[0]).toContain('http://[::1]:5173');
  });

  test('Local_Mode lines match today\'s messages', () => {
    expect(formatStartupLines(LOCAL_DEFAULTS)).toEqual([
      'Camping accounts ready: http://127.0.0.1:5173',
      'First visit: create your own administrator. No default credentials. Listening on localhost only.'
    ]);
    const docker = parseDeploymentConfig({ HOST: '0.0.0.0', CAMPING_DOCKER_LOCAL_ONLY: '1' });
    expect(formatStartupLines(docker)[1]).toContain('Docker must publish this service only on localhost');
  });

  test('no line contains the OpenAI API key when CAMPING_OPENAI_API_KEY is set', () => {
    const key = 'sk-test-SECRET-1234567890abcdef';
    const previous = process.env.CAMPING_OPENAI_API_KEY;
    process.env.CAMPING_OPENAI_API_KEY = key;
    try {
      const env = { CAMPING_OPENAI_API_KEY: process.env.CAMPING_OPENAI_API_KEY, ...PUBLISHED };
      const lines = [
        ...formatStartupLines(parseDeploymentConfig(env), { value: 'all', source: 'default' }),
        ...formatStartupLines(parseDeploymentConfig({ CAMPING_OPENAI_API_KEY: key }))
      ];
      for (const line of lines) {
        expect(line).not.toContain(key);
        expect(line).not.toContain('sk-');
        expect(line).not.toContain('OPENAI_API_KEY');
      }
    } finally {
      if (previous === undefined) delete process.env.CAMPING_OPENAI_API_KEY;
      else process.env.CAMPING_OPENAI_API_KEY = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests for client address selection (Requirement 6).
// Generators build each address from structured parts, so the canonical form is
// known without calling the module's normalizeIp. The model below is a separate
// implementation of the Requirement 6 rule over those known canonical forms.
// ---------------------------------------------------------------------------
const octet = fc.integer({ min: 0, max: 255 });
const ipv4Parts = fc.tuple(octet, octet, octet, octet);
const v4Text = ([a, b, c, d]) => `${a}.${b}.${c}.${d}`;
const v4HexMapped = ([a, b, c, d]) => `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;

/** IPv4 spellings that all denote the same address. */
const v4Spellings = parts => {
  const text = v4Text(parts);
  return [text, `::ffff:${text}`, `::FFFF:${text}`, `0:0:0:0:0:ffff:${text}`, v4HexMapped(parts), v4HexMapped(parts).toUpperCase()];
};

/** Item: { canon, spellings } where canon is the expected normalized text. */
const ipv4Item = ipv4Parts.map(parts => ({ canon: v4Text(parts), spellings: v4Spellings(parts) }));

// Eight non-zero groups: the canonical text has no "::" compression and no leading zeros,
// and a non-zero first group can never be an IPv4-mapped address.
const group = fc.integer({ min: 1, max: 0xffff });
const ipv6Item = fc.tuple(group, group, group, group, group, group, group, group).map(groups => {
  const canon = groups.map(g => g.toString(16)).join(':');
  return { canon, spellings: [canon, canon.toUpperCase(), groups.map(g => g.toString(16).padStart(4, '0')).join(':')] };
});

const FIXED_ITEMS = [
  { canon: '127.0.0.1', spellings: v4Spellings([127, 0, 0, 1]) },
  { canon: '203.0.113.5', spellings: v4Spellings([203, 0, 113, 5]) },
  { canon: '10.0.0.1', spellings: v4Spellings([10, 0, 0, 1]) },
  { canon: '::1', spellings: ['::1', '0:0:0:0:0:0:0:1', '0::1', '0000:0000:0000:0000:0000:0000:0000:0001'] },
  { canon: '2001:db8::5', spellings: ['2001:db8::5', '2001:DB8:0:0:0:0:0:5', '2001:0db8::0005'] },
  { canon: 'fe80::1', spellings: ['fe80::1', 'FE80::1', 'fe80:0:0:0:0:0:0:1'] }
];

// A small fixed pool makes trusted/untrusted collisions frequent; random items widen coverage.
const validItem = fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...FIXED_ITEMS) }, { weight: 1, arbitrary: ipv4Item }, { weight: 1, arbitrary: ipv6Item });
const INVALID_TEXTS = ['', 'not-an-ip', 'unknown', '1.2.3', '256.1.1.1', '1.2.3.4.5', 'fe80::1%eth0', '[::1]', '1.2.3.4:80', '::ffff:999.1.1.1', 'gggg::1', '_hidden'];

/** Entry: { text, canon } with canon === null for an invalid address. */
const validEntry = validItem.chain(item => fc.constantFrom(...item.spellings).map(text => ({ text, canon: item.canon })));
const invalidEntry = fc.constantFrom(...INVALID_TEXTS).map(text => ({ text, canon: null }));
const entry = fc.oneof({ weight: 4, arbitrary: validEntry }, { weight: 1, arbitrary: invalidEntry });
const padding = fc.constantFrom('', ' ', '  ', '\t');
const paddedText = fc.tuple(padding, padding).map(([l, r]) => text => `${l}${text}${r}`);

/** X-Forwarded-For header text from entries, with random whitespace around each item. */
const xffFrom = entries => fc.array(paddedText, { minLength: entries.length, maxLength: entries.length })
  .map(pads => entries.map((e, i) => pads[i](e.text)).join(','));

/** Trusted set as canonical strings: a subset of the fixed pool plus random valid items. */
const trustedCanon = fc.tuple(fc.subarray(FIXED_ITEMS.map(i => i.canon)), fc.array(validItem, { maxLength: 3 }))
  .map(([fixed, extra]) => [...new Set([...fixed, ...extra.map(i => i.canon)])]);
const asArrayOrSet = list => fc.boolean().map(useSet => (useSet ? new Set(list) : list));

/** Independent model of Requirement 6.1-6.4 over known canonical forms. */
function modelSelect({ peer, xffEntries, trusted }) {
  const isTrusted = canon => canon !== null && trusted.includes(canon);
  if (peer.canon === null || !isTrusted(peer.canon) || xffEntries === null) {
    return { address: peer.canon ?? undefined, proxied: false };
  }
  // An empty header value splits into one empty (invalid) item.
  const entries = xffEntries.length ? xffEntries : [{ text: '', canon: null }];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isTrusted(entries[i].canon)) continue;
    return entries[i].canon === null ? { error: 'invalid-forwarded-for' } : { address: entries[i].canon, proxied: true };
  }
  return { address: entries[0].canon, proxied: true };
}

const peerArb = fc.oneof(
  { weight: 6, arbitrary: validEntry },
  { weight: 1, arbitrary: invalidEntry },
  { weight: 1, arbitrary: fc.constant({ text: undefined, canon: null }) }
);

describe('client address selection: properties', () => {
  test('Property 1: client address follows the trusted-proxy selection rule', () => {
    // Feature: publish-behind-nginx, Property 1: Client address follows the trusted-proxy selection rule
    const scenario = fc.record({
      trusted: trustedCanon,
      peer: peerArb,
      // Bias the peer toward trusted so the forwarded branch is exercised often.
      peerFromTrusted: fc.boolean(),
      xffEntries: fc.option(fc.array(entry, { maxLength: 6 }), { nil: null, freq: 5 })
    }).chain(s => {
      const peerArbitrary = s.peerFromTrusted && s.trusted.length
        ? fc.constantFrom(...s.trusted).map(canon => ({ text: canon, canon }))
        : fc.constant(s.peer);
      return fc.tuple(
        peerArbitrary,
        s.xffEntries === null ? fc.constant(null) : xffFrom(s.xffEntries),
        asArrayOrSet(s.trusted)
      ).map(([peer, xff, trustedArg]) => ({ ...s, peer, xff, trustedArg }));
    });
    fc.assert(fc.property(scenario, ({ trusted, peer, xffEntries, xff, trustedArg }) => {
      const actual = selectClientAddress({ peer: peer.text, xff, trusted: trustedArg });
      expect(actual).toEqual(modelSelect({ peer, xffEntries, trusted }));
    }), { numRuns: 300 });
  });

  test('Property 2: prepended forwarding entries cannot change the client address', () => {
    // Feature: publish-behind-nginx, Property 2: Prepended forwarding entries cannot change the client address
    const scenario = trustedCanon.filter(t => t.length > 0).chain(trusted => {
      const untrustedValid = validEntry.filter(e => !trusted.includes(e.canon));
      return fc.record({
        trusted: fc.constant(trusted),
        peerCanon: fc.constantFrom(...trusted),
        before: fc.array(entry, { maxLength: 3 }),
        anchor: untrustedValid,
        after: fc.array(entry, { maxLength: 3 }),
        attacker: fc.array(fc.oneof(fc.string(), validEntry.map(e => e.text), invalidEntry.map(e => e.text)), { minLength: 1, maxLength: 5 })
      });
    }).chain(s => {
      const entries = [...s.before, s.anchor, ...s.after];
      return xffFrom(entries).map(xff => ({ ...s, entries, xff }));
    });
    fc.assert(fc.property(scenario, ({ trusted, peerCanon, entries, xff, attacker }) => {
      const peer = peerCanon;
      const original = selectClientAddress({ peer, xff, trusted });
      const prepended = selectClientAddress({ peer, xff: `${attacker.join(',')},${xff}`, trusted });
      expect(original).toEqual(modelSelect({ peer: { canon: peerCanon }, xffEntries: entries, trusted }));
      expect(prepended).toEqual(original);
    }), { numRuns: 300 });
  });

  test('Property 3: IPv4 and IPv4-mapped IPv6 are the same address', () => {
    // Feature: publish-behind-nginx, Property 3: IPv4 and IPv4-mapped IPv6 are the same address
    const scenario = fc.record({
      a: ipv4Parts,
      client: ipv4Parts,
      mappedIndex: fc.integer({ min: 1, max: 5 }),
      trustedForm: fc.integer({ min: 0, max: 5 }),
      peerForm: fc.integer({ min: 0, max: 5 }),
      xffSelfForm: fc.integer({ min: 0, max: 5 }),
      trustA: fc.boolean()
    }).filter(s => v4Text(s.a) !== v4Text(s.client));
    fc.assert(fc.property(scenario, ({ a, client, mappedIndex, trustedForm, peerForm, xffSelfForm, trustA }) => {
      const canon = v4Text(a);
      const spellings = v4Spellings(a);
      const mapped = spellings[mappedIndex];
      expect(normalizeIp(mapped)).toBe(canon);
      expect(normalizeIp(canon)).toBe(canon);
      expect(normalizeIp(`::ffff:${canon}`)).toBe(normalizeIp(canon));

      // Trusted list read from configuration in either form; peer and an XFF hop in either form.
      const clientText = v4Text(client);
      const other = canon === '192.0.2.1' ? '192.0.2.2' : '192.0.2.1';
      const listed = trustA ? spellings[trustedForm] : other;
      const { trustedProxies } = parseDeploymentConfig({ CAMPING_TRUSTED_PROXIES: listed });
      const selected = selectClientAddress({ peer: spellings[peerForm], xff: `${clientText}, ${spellings[xffSelfForm]}`, trusted: trustedProxies });
      if (trustA) {
        expect(trustedProxies).toEqual([canon]);
        expect(selected).toEqual({ address: clientText, proxied: true });
      } else {
        expect(selected).toEqual({ address: canon, proxied: false });
      }
    }), { numRuns: 300 });
  });
});

// ---------------------------------------------------------------------------
// Property tests for host and origin decisions (Requirements 3, 4.3, 4.4, 5.1, 5.3, 6.6).
// Each generated hostname carries its kind ('loopback', 'ipv4', 'ipv6', 'domain') and, for
// domains, its lowercase name, so the models below never call the module under test.
// ---------------------------------------------------------------------------
const label = fc.stringMatching(/^[a-z]([a-z0-9]{0,6}[a-z])?$/);
const domainName = fc.array(label, { minLength: 1, maxLength: 3 }).map(parts => parts.join('.')).filter(name => name !== 'localhost');
const apexName = fc.tuple(label, label).map(([a, b]) => `${a}.${b}`);
const caseFlags = fc.array(fc.boolean(), { minLength: 64, maxLength: 64 });
const withCase = (text, flags) => [...text].map((ch, i) => (flags[i % flags.length] ? ch.toUpperCase() : ch)).join('');
const portSuffix = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null }).map(port => (port === null ? '' : `:${port}`));

const LOOPBACK_SPELLINGS = ['localhost', '127.0.0.1', '[::1]', '[0:0:0:0:0:0:0:1]'];
const loopbackHost = fc.constantFrom(...LOOPBACK_SPELLINGS).map(text => ({ text, kind: 'loopback' }));
const ipv4Host = fc.oneof(ipv4Parts.map(v4Text), fc.constantFrom('127.0.0.2', '192.168.1.10', '10.0.0.1'))
  .map(text => ({ text, kind: text === '127.0.0.1' ? 'loopback' : 'ipv4' }));
const ipv6Host = fc.oneof(
  ipv6Item.chain(item => fc.constantFrom(...item.spellings)),
  fc.constantFrom('2001:db8::5', 'fe80::1', '::ffff:7f00:2')
).map(text => ({ text: `[${text}]`, kind: 'ipv6' }));
const domainHost = name => ({ text: name, kind: 'domain', name });

/** Local_Mode config with random extra hosts, or Published_Mode with a random public hostname. */
const hostConfig = fc.oneof(
  fc.record({ extras: fc.array(domainName, { maxLength: 3 }), flags: caseFlags }).map(({ extras, flags }) => {
    const env = extras.length ? { CAMPING_LOCAL_EXTRA_HOSTS: extras.map(h => withCase(h, flags)).join(', ') } : {};
    return { published: false, extras, named: extras, config: parseDeploymentConfig(env) };
  }),
  fc.record({ sub: label, apex: apexName, port: portSuffix, flags: caseFlags }).map(({ sub, apex, port, flags }) => {
    const publicHostname = `${sub}.${apex}`;
    const config = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: `https://${withCase(publicHostname, flags)}${port}` });
    return { published: true, publicHostname, apex, named: [publicHostname, apex], config };
  })
);

/** Independent model of Requirement 3 Allowed_Hosts. */
function modelHostAllowed(model, host, isDirectLocal) {
  if (model.published) return (host.kind === 'domain' && host.name === model.publicHostname) || (host.kind === 'loopback' && isDirectLocal);
  return host.kind === 'loopback' || host.kind === 'ipv4' || host.kind === 'ipv6' || (host.kind === 'domain' && model.extras.includes(host.name));
}

describe('host and origin decisions: properties', () => {
  test('Property 4: host allowlist matches the mode model', async () => {
    // Feature: publish-behind-nginx, Property 4: Host allowlist matches the mode model
    const scenario = hostConfig.chain(model => fc.record({
      model: fc.constant(model),
      host: fc.oneof(
        { weight: 2, arbitrary: loopbackHost },
        { weight: 1, arbitrary: ipv4Host },
        { weight: 1, arbitrary: ipv6Host },
        { weight: 3, arbitrary: model.named.length ? fc.constantFrom(...model.named).map(domainHost) : domainName.map(domainHost) },
        { weight: 1, arbitrary: domainName.map(domainHost) }
      ),
      flags: caseFlags,
      port: portSuffix,
      isDirectLocal: fc.boolean(),
      // How a request that is not direct-local reaches the server: untrusted peer, or loopback peer with forwarding headers.
      indirect: fc.constantFrom('untrusted-peer', 'forwarded')
    }));
    let calls = 0;
    await fc.assert(fc.asyncProperty(scenario, async ({ model, host, flags, port, isDirectLocal, indirect }) => {
      const { config } = model;
      const urlText = `http://${withCase(host.text, flags)}${port}/api/session`;
      const hostname = new URL(urlText).hostname;
      if (host.kind === 'domain') expect(hostname).toBe(host.name);

      // isHostAllowed with the URL hostname (lowercase, no port) and the given isDirectLocal.
      expect(isHostAllowed(hostname, { config, isDirectLocal })).toBe(modelHostAllowed(model, host, isDirectLocal));

      // resolveRequestContext: build a request that is direct-local exactly when requested and the host is a loopback name.
      const peer = isDirectLocal || indirect === 'forwarded' ? '127.0.0.1' : '198.51.100.7';
      const headers = !isDirectLocal && indirect === 'forwarded' ? { 'x-forwarded-for': '203.0.113.5' } : {};
      const effectiveDirect = isDirectLocal && host.kind === 'loopback';
      const allowed = modelHostAllowed(model, host, effectiveDirect);
      const result = resolveRequestContext({ url: urlText, headers: new Headers(headers), peer, config });
      if (allowed) {
        expect(result.ok).toBe(true);
        expect(result.ctx.isDirectLocal).toBe(effectiveDirect);
      } else {
        expect(result).toEqual({ ok: false, status: 403, message: 'Forbidden host' });
      }

      // Through the HTTP handler: every rejection is a 403 that never calls the account service.
      const scoped = createHttpHandler({ root: '.', accounts: { handle: async () => { calls++; return new Response('ok'); } }, config });
      calls = 0;
      const response = await scoped(new Request(urlText, { headers }), { requestIP: () => ({ address: peer }) });
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(calls).toBe(allowed ? 1 : 0);
    }), { numRuns: 300 });
  });

  test('Property 5: expected origin and cookie security depend only on mode and proxy status', () => {
    // Feature: publish-behind-nginx, Property 5: Expected origin and cookie security depend only on mode and proxy status
    const PEERS = [
      { text: '127.0.0.1', canon: '127.0.0.1' },
      { text: '::ffff:127.0.0.1', canon: '127.0.0.1' },
      { text: '::1', canon: '::1' },
      { text: '10.0.0.1', canon: '10.0.0.1' },
      { text: '198.51.100.7', canon: '198.51.100.7' },
      { text: undefined, canon: null }
    ];
    const headerText = fc.oneof(
      fc.constantFrom('http', 'https', 'HTTPS', 'ftp', 'evil.example', 'www.our-littlemoments.com', 'localhost:5173'),
      fc.stringMatching(/^[\x21-\x7e]{0,20}$/)
    );
    const forwardedPair = present => (present ? fc.tuple(headerText, headerText) : fc.constant([null, null]));
    const scenario = fc.record({
      published: fc.boolean(),
      origin: fc.record({ sub: label, apex: apexName, port: portSuffix }),
      trustedEnv: fc.constantFrom(undefined, '10.0.0.1', '127.0.0.1, 10.0.0.1', '::ffff:10.0.0.1'),
      scheme: fc.constantFrom('http:', 'https:'),
      urlPort: portSuffix,
      peer: fc.constantFrom(...PEERS),
      xff: fc.option(fc.constantFrom('203.0.113.5', '198.51.100.9, 203.0.113.5', '10.0.0.1', '2001:db8::5, 127.0.0.1'), { nil: null }),
      hasProto: fc.boolean(),
      hasHost: fc.boolean(),
      hostChoice: fc.constantFrom('public', 'localhost', 'lan')
    }).chain(s => fc.tuple(forwardedPair(s.hasProto), forwardedPair(s.hasHost)).map(([proto, fhost]) => ({ ...s, proto, fhost })));

    fc.assert(fc.property(scenario, s => {
      const publicHostname = `${s.origin.sub}.${s.origin.apex}`;
      const publicOrigin = `https://${publicHostname}${s.origin.port === ':443' ? '' : s.origin.port}`;
      const env = s.published ? { CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: publicOrigin } : {};
      if (s.trustedEnv !== undefined) env.CAMPING_TRUSTED_PROXIES = s.trustedEnv;
      const config = parseDeploymentConfig(env);

      // Model trusted list (canonical) and proxy status, independent of selectClientAddress.
      const trusted = s.trustedEnv === undefined
        ? (s.published ? ['127.0.0.1', '::1'] : [])
        : s.trustedEnv.split(',').map(t => t.trim().replace(/^::ffff:/, ''));
      const proxied = s.peer.canon !== null && trusted.includes(s.peer.canon) && s.xff !== null;

      const host = s.hostChoice === 'public' ? publicHostname : s.hostChoice === 'localhost' ? 'localhost' : '192.168.1.10';
      const url = `${s.scheme}//${host}${s.urlPort}/api/login`;
      const build = (proto, fhost) => {
        const h = new Headers();
        if (s.xff !== null) h.set('x-forwarded-for', s.xff);
        if (proto !== null) h.set('x-forwarded-proto', proto);
        if (fhost !== null) h.set('x-forwarded-host', fhost);
        return resolveRequestContext({ url, headers: h, peer: s.peer.text, config });
      };
      const first = build(s.proto[0], s.fhost[0]);
      const second = build(s.proto[1], s.fhost[1]);

      // Changing only X-Forwarded-Proto / X-Forwarded-Host values changes nothing.
      expect(second).toEqual(first);
      if (!first.ok) {
        // Only host rejections are possible here (every X-Forwarded-For entry is valid).
        expect(first.status).toBe(403);
        return;
      }
      expect(first.ctx.isProxied).toBe(proxied);
      if (s.published && proxied) {
        expect(first.ctx.expectedOrigin).toBe(config.publicOrigin);
        expect(first.ctx.secureCookie).toBe(true);
      } else {
        const parsed = new URL(url);
        expect(first.ctx.expectedOrigin).toBe(parsed.origin);
        expect(first.ctx.secureCookie).toBe(parsed.protocol === 'https:');
      }
    }), { numRuns: 300 });
  });
});

// ---------------------------------------------------------------------------
// Property tests for configuration parsing (Requirements 2, 4.5, 10.4).
// `validEnv` builds environments that are valid by construction; each mutation
// below breaks exactly one setting and names the variable that must be reported.
// ---------------------------------------------------------------------------
const optional = arb => fc.option(arb, { nil: undefined });
const LOOPBACK_BINDS = ['127.0.0.1', 'localhost', '::1', '127.0.0.5', '::ffff:127.0.0.1'];
const NON_LOOPBACK_BINDS = ['0.0.0.0', '192.168.1.10', '::', '2001:db8::5', 'example.com'];
const originPort = fc.constantFrom('', ':443', ':80', ':8443', ':5173');
const trustedProxyList = fc.array(fc.tuple(validEntry, padding), { minLength: 1, maxLength: 4 })
  .map(items => items.map(([e, pad]) => `${pad}${e.text}${pad}`).join(','));

/** Valid environment plus the facts the mutations need (mode and bind opt-in). */
const validEnv = fc.record({
  published: fc.boolean(),
  publishedSpelling: fc.constantFrom(undefined, '0'),
  sub: label,
  apex: apexName,
  port: originPort,
  flags: caseFlags,
  localOrigin: fc.constantFrom('none', 'http:', 'https:'),
  trusted: optional(trustedProxyList),
  extras: fc.array(domainName, { maxLength: 3 }),
  registrationPublished: fc.constantFrom(undefined, 'closed'),
  registrationLocal: fc.constantFrom(undefined, 'open', 'closed'),
  receipt: fc.constantFrom(undefined, 'all', 'admins', 'off'),
  allowBind: fc.constantFrom(undefined, '0', '1'),
  docker: fc.constantFrom(undefined, '0', '1'),
  loopbackHost: optional(fc.constantFrom(...LOOPBACK_BINDS)),
  openHost: fc.constantFrom(...LOOPBACK_BINDS, ...NON_LOOPBACK_BINDS),
  appPort: optional(fc.integer({ min: 0, max: 65535 }))
}).map(s => {
  const env = {};
  const origin = scheme => `${scheme}//${withCase(`${s.sub}.${s.apex}`, s.flags)}${s.port}`;
  const docker = s.published ? undefined : s.docker;
  if (s.published) {
    env.CAMPING_PUBLISHED = '1';
    env.CAMPING_PUBLIC_ORIGIN = origin('https:');
    if (s.registrationPublished !== undefined) env.CAMPING_REGISTRATION = s.registrationPublished;
  } else {
    if (s.publishedSpelling !== undefined) env.CAMPING_PUBLISHED = s.publishedSpelling;
    if (s.localOrigin !== 'none') env.CAMPING_PUBLIC_ORIGIN = origin(s.localOrigin);
    if (s.extras.length) env.CAMPING_LOCAL_EXTRA_HOSTS = s.extras.map(h => withCase(h, s.flags)).join(', ');
    if (s.registrationLocal !== undefined) env.CAMPING_REGISTRATION = s.registrationLocal;
    if (docker !== undefined) env.CAMPING_DOCKER_LOCAL_ONLY = docker;
  }
  if (s.trusted !== undefined) env.CAMPING_TRUSTED_PROXIES = s.trusted;
  if (s.receipt !== undefined) env.CAMPING_RECEIPT_AI_POLICY = s.receipt;
  if (s.allowBind !== undefined) env.CAMPING_ALLOW_NON_LOOPBACK_BIND = s.allowBind;
  const optIn = s.allowBind === '1' || docker === '1';
  const host = optIn ? s.openHost : s.loopbackHost;
  if (host !== undefined) env.HOST = host;
  if (s.appPort !== undefined) env.PORT = String(s.appPort);
  return { env, published: s.published, host: `${s.sub}.${s.apex}` };
});

const BAD_BOOLEANS = ['true', 'false', 'yes', 'no', '2', '01', ' 1', '1 ', 'on', 'TRUE', '-1'];
const BAD_REGISTRATION = ['Open', 'CLOSED', 'invite', 'invites', 'none', ' open', 'closed '];
const BAD_RECEIPT = ['members', 'All', 'ADMINS', 'none', 'on', ' off', 'admin'];
const BAD_PROXIES = ['nginx.local', '1.2.3', '256.1.1.1', 'fe80::1%eth0', '[::1]', '1.2.3.4:80', 'localhost', '::ffff:999.1.1.1'];
const BAD_HOSTNAMES = ['bad_host!', '-lead.lan', 'trail-.lan', 'a..b', 'under_score', 'sp ace.lan', 'camp.lan.', `${'a'.repeat(64)}.lan`];

/** Each mutation: which modes it applies to and how it breaks exactly one setting. */
const MUTATIONS = [
  { modes: [true, false], setting: ENV.published, values: BAD_BOOLEANS, apply: (env, v) => ({ ...env, CAMPING_PUBLISHED: v }) },
  { modes: [true, false], setting: ENV.allowNonLoopbackBind, values: BAD_BOOLEANS,
    // Keep HOST loopback so the bind check cannot fire first if it ran earlier.
    apply: (env, v) => ({ ...env, CAMPING_ALLOW_NON_LOOPBACK_BIND: v, CAMPING_DOCKER_LOCAL_ONLY: undefined, HOST: '127.0.0.1' }) },
  { modes: [true, false], setting: ENV.registration, values: BAD_REGISTRATION, apply: (env, v) => ({ ...env, CAMPING_REGISTRATION: v }) },
  { modes: [true, false], setting: ENV.receiptAiPolicy, values: BAD_RECEIPT, apply: (env, v) => ({ ...env, CAMPING_RECEIPT_AI_POLICY: v }) },
  { modes: [true, false], setting: ENV.trustedProxies, values: BAD_PROXIES,
    apply: (env, v) => ({ ...env, CAMPING_TRUSTED_PROXIES: env.CAMPING_TRUSTED_PROXIES ? `${env.CAMPING_TRUSTED_PROXIES}, ${v}` : v }) },
  { modes: [false], setting: ENV.localExtraHosts, values: BAD_HOSTNAMES,
    apply: (env, v) => ({ ...env, CAMPING_LOCAL_EXTRA_HOSTS: env.CAMPING_LOCAL_EXTRA_HOSTS ? `${env.CAMPING_LOCAL_EXTRA_HOSTS}, ${v}` : v }) },
  { modes: [true], setting: ENV.publicOrigin, values: ['http:'],
    apply: (env, _v, host) => ({ ...env, CAMPING_PUBLIC_ORIGIN: `http://${host}` }) },
  { modes: [true, false], setting: ENV.publicOrigin, values: ['/app', '/a/b', '?x=1', '/?q', '#top', '/#', 'user:pw@', 'user@', 'ftp:', 'not a url'],
    apply: (env, v, host, published) => {
      const scheme = published ? 'https' : 'http';
      const origin = v === 'user:pw@' || v === 'user@' ? `${scheme}://${v}${host}`
        : v === 'ftp:' ? `ftp://${host}`
        : v === 'not a url' ? `${scheme}://exa mple.com`
        : `${scheme}://${host}${v}`;
      return { ...env, CAMPING_PUBLIC_ORIGIN: origin };
    } },
  { modes: [true, false], setting: ENV.host, values: NON_LOOPBACK_BINDS,
    apply: (env, v) => ({ ...env, HOST: v, CAMPING_ALLOW_NON_LOOPBACK_BIND: undefined, CAMPING_DOCKER_LOCAL_ONLY: undefined }) },
  { modes: [true], setting: ENV.registration, values: ['open'], apply: env => ({ ...env, CAMPING_REGISTRATION: 'open' }) }
];

const withoutUndefined = env => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));

/** DeploymentConfig back to environment variables. */
function configToEnv(config) {
  const env = {
    CAMPING_PUBLISHED: config.published ? '1' : '0',
    CAMPING_ALLOW_NON_LOOPBACK_BIND: config.nonLoopbackBindOptIn ? '1' : '0',
    CAMPING_DOCKER_LOCAL_ONLY: config.dockerLocalOnly ? '1' : '0',
    CAMPING_REGISTRATION: config.registrationPolicy,
    CAMPING_TRUSTED_PROXIES: config.trustedProxies.join(','),
    CAMPING_LOCAL_EXTRA_HOSTS: config.localExtraHosts.join(','),
    HOST: config.bindHost,
    PORT: String(config.port)
  };
  if (config.publicOrigin !== null) env.CAMPING_PUBLIC_ORIGIN = config.publicOrigin;
  if (config.receiptAiPolicySeed !== null) env.CAMPING_RECEIPT_AI_POLICY = config.receiptAiPolicySeed;
  return env;
}

describe('configuration parsing: properties', () => {
  test('Property 7: invalid setting values stop startup with a named error', () => {
    // Feature: publish-behind-nginx, Property 7: Invalid setting values stop startup with a named error
    const scenario = validEnv.chain(base => {
      const applicable = MUTATIONS.filter(m => m.modes.includes(base.published));
      return fc.constantFrom(...applicable).chain(mutation => fc.constantFrom(...mutation.values).map(value => ({
        base,
        mutation,
        value,
        env: withoutUndefined(mutation.apply(base.env, value, base.host, base.published))
      })));
    });
    let sawPublishedOpen = false;
    fc.assert(fc.property(scenario, ({ base, mutation, value, env }) => {
      // The unmutated base is valid, so the mutation is the only invalid setting.
      expect(() => parseDeploymentConfig(base.env)).not.toThrow();
      if (base.published && mutation.setting === ENV.registration && value === 'open') sawPublishedOpen = true;
      let error;
      try { parseDeploymentConfig(env); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.setting).toBe(mutation.setting);
      expect(error.message).toContain(mutation.setting);
    }), { numRuns: 500 });
    expect(sawPublishedOpen).toBe(true);
  });

  test('Property 8: configuration normalization is idempotent', () => {
    // Feature: publish-behind-nginx, Property 8: Configuration normalization is idempotent
    fc.assert(fc.property(validEnv, ({ env, published }) => {
      const first = parseDeploymentConfig(env);
      const second = parseDeploymentConfig(configToEnv(first));
      expect(second).toEqual(first);
      expect(configToEnv(second)).toEqual(configToEnv(first));
      expect(first.published).toBe(published);
      if (first.publicOrigin !== null) {
        // The normalized origin is a fixed point of normalization.
        expect(new URL(first.publicOrigin).origin).toBe(first.publicOrigin);
        expect(parseDeploymentConfig({ ...env, CAMPING_PUBLIC_ORIGIN: first.publicOrigin }).publicOrigin).toBe(first.publicOrigin);
      }
      if (first.published) expect(first.registrationPolicy).toBe('closed');
    }), { numRuns: 300 });
  });
});
