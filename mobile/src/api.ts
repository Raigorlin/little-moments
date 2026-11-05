import * as SecureStore from 'expo-secure-store';

const API_URL_KEY = 'little-moments.api-url';
const SESSION_KEY = 'little-moments.session-cookie';
const DEFAULT_API_URL = 'http://127.0.0.1:5182';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function normalizeBaseUrl(value: string) {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('請輸入完整的 HTTP/HTTPS 伺服器網址，例如 http://192.168.1.20:5182。');
  }
  return parsed.origin;
}

export async function getApiBaseUrl() {
  const stored = await SecureStore.getItemAsync(API_URL_KEY);
  return stored ? normalizeBaseUrl(stored) : DEFAULT_API_URL;
}

export async function setApiBaseUrl(value: string) {
  const next = normalizeBaseUrl(value);
  const current = await getApiBaseUrl();
  if (next !== current) await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.setItemAsync(API_URL_KEY, next);
  return next;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const baseUrl = await getApiBaseUrl();
  const method = options.method || 'GET';
  const cookie = await SecureStore.getItemAsync(SESSION_KEY);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    headers.Origin = baseUrl;
  }
  if (cookie) headers.Cookie = `ggc_session=${cookie}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch {
    throw new ApiError(`無法連線到 ${baseUrl}。請確認伺服器位址、網路和伺服器狀態。`, 0);
  }

  const setCookie = response.headers.get('set-cookie') || '';
  const sessionMatch = setCookie.match(/(?:^|[,;]\s*)ggc_session=([^;,]*)/);
  if (sessionMatch) {
    if (sessionMatch[1]) await SecureStore.setItemAsync(SESSION_KEY, sessionMatch[1]);
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401) await SecureStore.deleteItemAsync(SESSION_KEY);
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `伺服器回應錯誤（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function clearSession() {
  return SecureStore.deleteItemAsync(SESSION_KEY);
}
