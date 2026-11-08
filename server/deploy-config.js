// Deployment configuration and per-request proxy/host/origin rules.
// Pure module: no file, network, or database access, so tests can import it directly.
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(setting, message) {
    super(message);
    this.name = 'ConfigError';
    this.setting = setting;
  }
}

export const ENV = Object.freeze({
  published: 'CAMPING_PUBLISHED',
  publicOrigin: 'CAMPING_PUBLIC_ORIGIN',
  trustedProxies: 'CAMPING_TRUSTED_PROXIES',
  localExtraHosts: 'CAMPING_LOCAL_EXTRA_HOSTS',
  allowNonLoopbackBind: 'CAMPING_ALLOW_NON_LOOPBACK_BIND',
  registration: 'CAMPING_REGISTRATION',
  receiptAiPolicy: 'CAMPING_RECEIPT_AI_POLICY',
  dockerLocalOnly: 'CAMPING_DOCKER_LOCAL_ONLY',
  host: 'HOST',
  port: 'PORT'
});

const REGISTRATION_POLICIES = ['open', 'closed'];
const RECEIPT_AI_SEEDS = ['all', 'admins', 'off'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];
const DEFAULT_PUBLISHED_PROXIES = ['127.0.0.1', '::1'];

const isUnset = value => value === undefined || value === null || value === '';

/** Canonical IP text, or null when `value` is not a plain IPv4/IPv6 address. */
export function normalizeIp(value) {
  if (typeof value !== 'string' || value.includes('%') || value.includes('[') || value.includes(']')) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  let host;
  try { host = new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { return null; }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mappedDotted && isIP(mappedDotted[1]) === 4) return mappedDotted[1];
  return host;
}

export function isLoopbackAddress(ip) {
  const n = normalizeIp(ip);
  return n !== null && (n === '::1' || n.startsWith('127.'));
}

/** True for a URL hostname that is an IPv4 address or a bracketed IPv6 address. */
export function isIpLiteralHost(hostname) {
  if (typeof hostname !== 'string') return false;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return isIP(hostname.slice(1, -1)) === 6;
  return isIP(hostname) === 4;
}

const headerValue = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value ?? null;
  return null;
};

export function hasForwardingHeaders(headers) {
  return FORWARDING_HEADERS.some(name => headerValue(headers, name) !== null);
}

/**
 * Client address per Requirement 6. `trusted` holds normalized IPs.
 * Returns { address, proxied } or { error: 'invalid-forwarded-for' }.
 */
export function selectClientAddress({ peer, xff, trusted }) {
  const trustedSet = trusted instanceof Set ? trusted : new Set(trusted ?? []);
  const peerN = normalizeIp(peer);
  if (peerN === null || !trustedSet.has(peerN) || xff === null || xff === undefined) {
    return { address: peerN ?? undefined, proxied: false };
  }
  const entries = String(xff).split(',').map(entry => entry.trim());
  for (let i = entries.length - 1; i >= 0; i--) {
    const n = normalizeIp(entries[i]);
    if (n !== null && trustedSet.has(n)) continue;
    return n !== null ? { address: n, proxied: true } : { error: 'invalid-forwarded-for' };
  }
  return { address: normalizeIp(entries[0]), proxied: true };
}

export function isHostAllowed(hostname, { config, isDirectLocal }) {
  const loopback = LOOPBACK_HOSTS.has(hostname);
  if (config.published) return hostname === config.publicHostname || (loopback && !!isDirectLocal);
  return loopback || isIpLiteralHost(hostname) || config.localExtraHosts.includes(hostname);
}

export function resolveRequestContext({ url, headers, peer, config }) {
  const u = url instanceof URL ? url : new URL(url);
  const peerKnown = typeof peer === 'string';
  // Unknown peer (in-process test calls): Local_Mode treats it as loopback like today's isLoopback;
  // Published_Mode treats it as untrusted and not local.
  const peerLocal = peerKnown ? isLoopbackAddress(peer) : !config.published;
  const isDirectLocal = peerLocal && LOOPBACK_HOSTS.has(u.hostname) && !hasForwardingHeaders(headers);
  if (!isHostAllowed(u.hostname, { config, isDirectLocal })) return { ok: false, status: 403, message: 'Forbidden host' };
  const selected = selectClientAddress({ peer, xff: headerValue(headers, 'x-forwarded-for'), trusted: config.trustedProxies });
  if (selected.error) return { ok: false, status: 400, message: 'Bad forwarding header' };
  const isProxied = selected.proxied;
  const viaProxy = config.published && isProxied;
  return {
    ok: true,
    ctx: {
      ip: peer,
      clientAddress: selected.address ?? undefined,
      isProxied,
      isDirectLocal,
      expectedOrigin: viaProxy ? config.publicOrigin : u.origin,
      secureCookie: viaProxy ? true : u.protocol === 'https:',
      published: config.published
    }
  };
}

function parseBoolean(env, name) {
  const raw = env[name];
  if (isUnset(raw) || raw === '0') return false;
  if (raw === '1') return true;
  throw new ConfigError(name, `${name} must be 1 or 0 (or unset); got "${raw}". Accepted values: 1, 0.`);
}

function parseChoice(env, name, accepted) {
  const raw = env[name];
  if (isUnset(raw)) return null;
  if (accepted.includes(raw)) return raw;
  throw new ConfigError(name, `${name} has an invalid value "${raw}". Accepted values: ${accepted.join(', ')}.`);
}

const splitList = raw => isUnset(raw) ? [] : String(raw).split(',').map(item => item.trim()).filter(Boolean);
const unique = list => [...new Set(list)];

function parsePublicOrigin(env, published) {
  const name = ENV.publicOrigin;
  const raw = env[name];
  if (isUnset(raw)) {
    if (published) throw new ConfigError(name, `${name} is required when ${ENV.published}=1, for example https://www.our-littlemoments.com.`);
    return null;
  }
  const shape = `${name} must be an origin only (scheme, hostname, optional port), for example https://www.our-littlemoments.com`;
  if (raw.includes('?') || raw.includes('#')) throw new ConfigError(name, `${shape}; it must not contain a query or fragment.`);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new ConfigError(name, `${shape}; "${raw}" is not a valid URL.`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ConfigError(name, `${shape}; the scheme must be https:.`);
  if (published && parsed.protocol !== 'https:') throw new ConfigError(name, `${name} must use https: when ${ENV.published}=1.`);
  if (parsed.username || parsed.password) throw new ConfigError(name, `${shape}; it must not contain credentials.`);
  if (parsed.pathname !== '/') throw new ConfigError(name, `${shape}; it must not contain a path.`);
  return parsed.origin;
}

function parsePort(env) {
  const raw = env[ENV.port];
  if (isUnset(raw)) return 5173;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(ENV.port, `${ENV.port} must be an integer from 0 to 65535; got "${raw}".`);
  return port;
}

const deepFreeze = config => {
  for (const value of Object.values(config)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(config);
};

/** Reads and validates the deployment settings. Throws ConfigError naming the bad setting. */
export function parseDeploymentConfig(env = {}) {
  const published = parseBoolean(env, ENV.published);
  const allowNonLoopbackBind = parseBoolean(env, ENV.allowNonLoopbackBind);
  const dockerLocalOnly = env[ENV.dockerLocalOnly] === '1';

  if (published && dockerLocalOnly) {
    throw new ConfigError(ENV.dockerLocalOnly, `${ENV.published}=1 cannot be combined with ${ENV.dockerLocalOnly}=1: the Docker local-only setup trusts the container network for first-admin setup, which is unsafe for the published site.`);
  }

  const publicOrigin = parsePublicOrigin(env, published);

  const bindHost = isUnset(env[ENV.host]) ? '127.0.0.1' : String(env[ENV.host]);
  const nonLoopbackBindOptIn = allowNonLoopbackBind || dockerLocalOnly;
  if (bindHost !== 'localhost' && !isLoopbackAddress(bindHost) && !nonLoopbackBindOptIn) {
    throw new ConfigError(ENV.host, `${ENV.host}=${bindHost} is not a loopback address. Set ${ENV.allowNonLoopbackBind}=1 to listen on it deliberately, or keep the default 127.0.0.1 behind nginx.`);
  }
  const port = parsePort(env);

  let trustedProxies = DEFAULT_PUBLISHED_PROXIES.slice(0, published ? 2 : 0);
  const proxyItems = splitList(env[ENV.trustedProxies]);
  if (proxyItems.length) {
    trustedProxies = unique(proxyItems.map(item => {
      const n = normalizeIp(item);
      if (n === null) throw new ConfigError(ENV.trustedProxies, `${ENV.trustedProxies} entry "${item}" is not a valid IPv4 or IPv6 address.`);
      return n;
    }));
  }

  const extraItems = splitList(env[ENV.localExtraHosts]);
  if (published && extraItems.length) {
    throw new ConfigError(ENV.localExtraHosts, `${ENV.localExtraHosts} applies only to Local_Mode; remove it when ${ENV.published}=1 (LAN devices use the public hostname through nginx).`);
  }
  const localExtraHosts = unique(extraItems.map(item => {
    const host = item.toLowerCase();
    if (!HOSTNAME_RE.test(host)) throw new ConfigError(ENV.localExtraHosts, `${ENV.localExtraHosts} entry "${item}" is not a valid hostname.`);
    return host;
  }));

  const registration = parseChoice(env, ENV.registration, REGISTRATION_POLICIES);
  if (published && registration === 'open') {
    throw new ConfigError(ENV.registration, `${ENV.registration}=open is not allowed with ${ENV.published}=1: public registration is locked; people join through trip invitation links.`);
  }
  const registrationPolicy = published ? 'closed' : (registration ?? 'open');
  const receiptAiPolicySeed = parseChoice(env, ENV.receiptAiPolicy, RECEIPT_AI_SEEDS);

  return deepFreeze({
    published,
    publicOrigin,
    publicHostname: publicOrigin ? new URL(publicOrigin).hostname : null,
    bindHost,
    port,
    trustedProxies,
    localExtraHosts,
    nonLoopbackBindOptIn,
    dockerLocalOnly,
    registrationPolicy,
    receiptAiPolicySeed
  });
}

export const LOCAL_DEFAULTS = parseDeploymentConfig({});

export function resolveDbPath(env, projectRoot) {
  return env?.CAMPING_DB || resolve(projectRoot, 'data/accounts.sqlite');
}

const SOURCE_LABELS = { default: 'default', seed: `from ${ENV.receiptAiPolicy}`, stored: 'admin setting' };

/**
 * Startup log lines built only from config fields and the effective receipt AI policy.
 * `receiptAiPolicy` is the `{ value, source }` object from accounts.receiptAiPolicy() or a plain value.
 */
export function formatStartupLines(config, receiptAiPolicy) {
  if (!config.published) {
    return [
      `Camping accounts ready: http://127.0.0.1:${config.port}`,
      config.dockerLocalOnly
        ? 'First visit: create your own administrator. No default credentials. Docker must publish this service only on localhost.'
        : 'First visit: create your own administrator. No default credentials. Listening on localhost only.'
    ];
  }
  const policy = typeof receiptAiPolicy === 'string' ? { value: receiptAiPolicy, source: 'default' } : (receiptAiPolicy ?? { value: 'all', source: 'default' });
  const value = RECEIPT_AI_SEEDS.includes(policy.value) ? policy.value : 'off';
  const source = SOURCE_LABELS[policy.source] ?? 'default';
  const host = config.bindHost.includes(':') ? `[${config.bindHost}]` : config.bindHost;
  return [
    `Camping accounts ready: ${config.publicOrigin} (app listening on http://${host}:${config.port})`,
    `Registration: closed (trip invitation links only). Receipt AI policy: ${value} (${source}).`
  ];
}
