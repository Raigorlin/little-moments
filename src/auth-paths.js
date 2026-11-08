// Pure login return-path helpers (security-hardening Req 1.2, 1.9).
// No DOM access and no import side effects, so unit tests can import this module.

// Private_Page patterns: /{username}/home, /{username}/trips/{id}, /{username}/trips/{id}/go,
// /invite/{64 lowercase hex}, and /admin. Usernames follow USERNAME_RE and trip IDs follow the
// server's ID rule, so a matching value is a same-origin path with no query, fragment, or scheme.
export const PRIVATE_PATH_RE = /^\/(?:admin|invite\/[0-9a-f]{64}|[a-z][a-z0-9-]{2,31}\/(?:home|trips\/[A-Za-z0-9-]{1,64}(?:\/go)?))$/;

export const safeNext = value => (typeof value === 'string' && PRIVATE_PATH_RE.test(value) ? value : null);

export const loginPath = path => (safeNext(path) ? `/login?next=${encodeURIComponent(path)}` : '/login');
