// Safe error logging for uncaught request errors. Pure formatting: the only
// side effect is calling `sink` in logRequestError.
//
// A log line holds only the ISO time, the method, the path without query
// string, and a sanitized error name. Error messages, stacks, request bodies,
// cookies, query strings, and headers never reach the line.

export const GENERIC_500 = '伺服器暫時無法處理，請稍後再試。';

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const METHOD = /^[A-Z]{1,16}$/;

const safeName = error => {
  let name;
  try { name = error?.name; } catch { name = undefined; }
  return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'Error';
};

const safeMethod = method => typeof method === 'string' && METHOD.test(method) ? method : 'UNKNOWN';

const safeTime = at => {
  const ms = Number.isFinite(at) ? at : Date.now();
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

// Returns the URL pathname only. Accepts a URL object or a string; anything
// else, or an unparseable value, becomes '/'. The pathname of a parsed URL is
// percent-encoded, so it holds no whitespace or control characters.
export function pathOf(url) {
  try {
    const parsed = url instanceof URL ? url : new URL(String(url), 'http://localhost');
    return parsed.pathname || '/';
  } catch {
    return '/';
  }
}

export function formatErrorLine({ at, method, path, error } = {}) {
  return `${safeTime(at)} ${safeMethod(method)} ${pathOf(path)} ${safeName(error)}`;
}

export function logRequestError({ method, url, error, at = Date.now(), sink = console.error } = {}) {
  const line = formatErrorLine({ at, method, path: url, error });
  try { sink(line); } catch { /* logging must never change the response */ }
}
