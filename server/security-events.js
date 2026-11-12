// Failed-login events and Security_Alerts.
// The first part is pure: no database access. The database-backed store at the
// end of this file (createSecurityEventStore, PostgreSQL through Bun.SQL) is
// passed to createAlertDispatcher as `store`.

import { randomUUID } from 'node:crypto';
import { toSafeInt } from './db/queries.js';
import { withWriteTx } from './db/tx.js';

export const EVENT_REASONS = Object.freeze(['invalid_input', 'rate_limited', 'deleted_account', 'bad_credentials']);

export const ALERT_RULES = Object.freeze({
  perUsername: Object.freeze({ count: 5 }),
  global: Object.freeze({ count: 20 }),
  windowMs: 900_000,
  cooldownMs: 900_000
});

export const INVALID_USERNAME = '(invalid)';
export const ALL_USERNAMES = '(all)';

// Same format as validateUsername in server/accounts.js.
const USERNAME_RE = /^[a-z][a-z0-9-]{2,31}$/;
const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NOTIFIER_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

// Normalized username for a Failed_Login_Event. Anything out of format is
// stored as '(invalid)' so submitted text never reaches the store or the log.
export function eventUsername(raw) {
  if (typeof raw !== 'string') return INVALID_USERNAME;
  const name = raw.trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : INVALID_USERNAME;
}

const alertKey = (kind, username) => (kind === 'global' ? 'global' : `username:${username}`);

const cooledDown = (last, at, rules) =>
  last === undefined || last === null || last <= at - rules.cooldownMs;

// event: the new Failed_Login_Event { at, client, username, reason }.
// recent: events in (event.at - windowMs, event.at], including `event`.
// lastAlertAt: { 'username:<name>': ms, global: ms } for the previous alert of each key.
// Returns the alerts to create, per-username first.
export function evaluateAlerts({ event, recent, lastAlertAt = {}, rules = ALERT_RULES }) {
  const windowStart = event.at - rules.windowMs;
  const inWindow = (recent || []).filter(item => item.at > windowStart && item.at <= event.at);
  const base = { at: event.at, client: String(event.client ?? ''), windowStart, windowEnd: event.at };
  const alerts = [];

  if (event.username !== INVALID_USERNAME) {
    const count = inWindow.filter(item => item.username === event.username).length;
    if (count >= rules.perUsername.count && cooledDown(lastAlertAt[alertKey('username', event.username)], event.at, rules)) {
      alerts.push({ ...base, kind: 'username', username: event.username, count });
    }
  }

  const total = inWindow.length;
  if (total >= rules.global.count && cooledDown(lastAlertAt[alertKey('global')], event.at, rules)) {
    alerts.push({ ...base, kind: 'global', username: ALL_USERNAMES, count: total });
  }

  return alerts;
}

const iso = ms => {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'invalid-time' : date.toISOString();
};

const safeErrorName = error => (ERROR_NAME_RE.test(error?.name) ? error.name : 'Error');

// One log line per Security_Alert. The username is re-normalized so that no
// out-of-format text can reach the log even if a caller skipped eventUsername.
export function formatAlertLine(alert) {
  const kind = alert.kind === 'global' ? 'global' : 'username';
  const username = kind === 'global' ? ALL_USERNAMES : eventUsername(alert.username);
  const count = Number.isInteger(alert.count) ? alert.count : 0;
  return `security-alert type=${kind} username=${username} count=${count} window=${iso(alert.windowStart)}..${iso(alert.windowEnd)}`;
}

const notifierLabel = (notifier, index) =>
  (typeof notifier?.name === 'string' && NOTIFIER_NAME_RE.test(notifier.name) ? notifier.name : `notifier#${index}`);

const failLine = (notifier, index, error) =>
  `security-alert-notifier-failed notifier=${notifierLabel(notifier, index)} error=${safeErrorName(error)}`;

// The single path through which Security_Alerts are created.
// dispatch(alert, { executor, defer }) awaits store.insertAlert(alert, executor)
// (a plain value or a promise) and resolves to the stored alert; the log line
// follows; notifiers run later, each isolated, and are never awaited, so they
// cannot change or delay the caller's response. `defer` schedules the delivery
// (default queueMicrotask); the store passes one that runs after its
// transaction commits, so a rolled-back alert never reaches a notifier.
export function createAlertDispatcher({ store, log = console.error, notifiers = [] } = {}) {
  const list = [...notifiers];

  const safeLog = line => {
    try { log(line); } catch { /* logging must not affect alert handling */ }
  };

  function deliver(stored, snapshot) {
    snapshot.forEach((notifier, index) => {
      try {
        const result = notifier(stored);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(error => safeLog(failLine(notifier, index, error)));
        }
      } catch (error) {
        safeLog(failLine(notifier, index, error));
      }
    });
  }

  return {
    async dispatch(alert, { executor, defer = queueMicrotask } = {}) {
      const stored = await store.insertAlert(alert, executor);
      safeLog(formatAlertLine(stored));
      const snapshot = [...list];
      if (snapshot.length) defer(() => deliver(stored, snapshot));
      return stored;
    },
    register(notifier) {
      if (typeof notifier !== 'function') throw new TypeError('Alert notifier must be a function.');
      list.push(notifier);
    }
  };
}

// ---------------------------------------------------------------------------
// Database part (Security_Event_Store), PostgreSQL through Bun.SQL.
//
// The tables (security_events, security_alerts) are created by
// migrations/0002_security_harden.sql. They are separate from `audit`, so a
// flood of failed logins cannot push account actions out of it.
//
// Every method that reads or writes takes an optional executor `e` as its
// last argument: the pool `sql` (default) or a transaction `t` from
// withWriteTx. Callers inside a transaction must pass `t`. All values are
// parameters of tagged templates; no SQL is built from strings.

export const SECURITY_EVENT_LIMITS = Object.freeze({ maxEvents: 5000, maxAlerts: 1000, listEvents: 200 });

const ALERT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CLIENT_MAX = 64;

const int = (value, column) => toSafeInt(value, column);

const toAlert = row => ({
  id: row.id, at: int(row.at, 'at'), kind: row.kind, username: row.username, client: row.client, count: int(row.count, 'count'),
  windowStart: int(row.window_start, 'window_start'), windowEnd: int(row.window_end, 'window_end'),
  acknowledgedAt: int(row.acknowledged_at ?? null, 'acknowledged_at'), acknowledgedBy: row.acknowledged_by ?? null
});
const toEvent = row => ({ at: int(row.at, 'at'), client: row.client, username: row.username, reason: row.reason });

// Dispatcher wiring: the store is created first and handed to
// createAlertDispatcher({ store }); the dispatcher is then attached with
// store.attachDispatcher(dispatcher). This avoids a circular constructor
// dependency (the dispatcher needs store.insertAlert, recordFailedLogin needs
// dispatcher.dispatch). recordFailedLogin also accepts a dispatcher argument,
// which tests can use instead of attaching one. With no dispatcher at all it
// throws, so no Security_Alert can be created outside the Alert_Dispatcher
// (Req 23.16).
//
// sql: the Bun.SQL pool (schema created by the Migration_Runner).
// clock: () => epoch ms, used when an event carries no `at`.
export function createSecurityEventStore(sql, clock = Date.now, {
  maxEvents = SECURITY_EVENT_LIMITS.maxEvents,
  maxAlerts = SECURITY_EVENT_LIMITS.maxAlerts,
  rules = ALERT_RULES
} = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function') throw new TypeError('createSecurityEventStore needs a Bun.SQL pool.');
  let attached = null;

  const insertEvent = async ({ at, client, username, reason }, e = sql) => {
    if (!EVENT_REASONS.includes(reason)) throw new TypeError('Unknown failed-login reason.');
    const event = {
      at: Number.isFinite(at) ? Math.trunc(at) : clock(),
      client: String(client ?? '').slice(0, CLIENT_MAX),
      username: eventUsername(username),
      reason
    };
    await e`INSERT INTO security_events (at, client, username, reason)
      VALUES (${event.at}, ${event.client}, ${event.username}, ${event.reason})`;
    return event;
  };

  // Events in (at - windowMs, at], the span evaluateAlerts expects.
  const windowEvents = async (at, e = sql) => (await e`
    SELECT at, client, username, reason FROM security_events
    WHERE at > ${at - rules.windowMs} AND at <= ${at} ORDER BY at, id`).map(toEvent);

  // Keys match evaluateAlerts: 'username:<name>' and 'global'.
  const lastAlertAt = async (username, e = sql) => {
    const out = {};
    if (username && username !== INVALID_USERNAME) {
      const [row] = await e`SELECT MAX(at) AS at FROM security_alerts WHERE kind = 'username' AND username = ${username}`;
      if (row?.at !== null && row?.at !== undefined) out[`username:${username}`] = int(row.at, 'at');
    }
    const [global] = await e`SELECT MAX(at) AS at FROM security_alerts WHERE kind = 'global'`;
    if (global?.at !== null && global?.at !== undefined) out.global = int(global.at, 'at');
    return out;
  };

  // Called by the Alert_Dispatcher only.
  const insertAlert = async (alert, e = sql) => {
    const kind = alert.kind === 'global' ? 'global' : 'username';
    const row = {
      id: randomUUID(), at: alert.at, kind,
      username: kind === 'global' ? ALL_USERNAMES : eventUsername(alert.username),
      client: String(alert.client ?? '').slice(0, CLIENT_MAX),
      count: alert.count, window_start: alert.windowStart, window_end: alert.windowEnd
    };
    await e`INSERT INTO security_alerts (id, at, kind, username, client, count, window_start, window_end)
      VALUES (${row.id}, ${row.at}, ${row.kind}, ${row.username}, ${row.client}, ${row.count}, ${row.window_start}, ${row.window_end})`;
    return toAlert(row);
  };

  const countOf = rows => int(rows[0]?.n ?? 0, 'n');

  // Keeps the newest maxEvents events, and at most maxAlerts alerts, removing
  // acknowledged alerts (oldest first) before any unacknowledged one (Req 23.4).
  // seq stands in for SQLite's rowid as the insertion-order tie-breaker.
  const trim = async (e = sql) => {
    await e`DELETE FROM security_events WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT ${maxEvents})`;
    let excess = countOf(await e`SELECT COUNT(*) AS n FROM security_alerts`) - maxAlerts;
    if (excess > 0) {
      const acked = await e`DELETE FROM security_alerts WHERE seq IN (SELECT seq FROM security_alerts
        WHERE acknowledged_at IS NOT NULL ORDER BY at, seq LIMIT ${excess})`;
      excess -= int(acked.count ?? 0, 'count');
      if (excess > 0) {
        await e`DELETE FROM security_alerts WHERE seq IN (SELECT seq FROM security_alerts
          WHERE acknowledged_at IS NULL ORDER BY at, seq LIMIT ${excess})`;
      }
    }
  };

  return {
    attachDispatcher(dispatcher) {
      if (!dispatcher || typeof dispatcher.dispatch !== 'function') throw new TypeError('Alert dispatcher required.');
      attached = dispatcher;
    },
    insertEvent,
    windowEvents,
    lastAlertAt,
    insertAlert,
    trim,
    // Inserts the event, evaluates the thresholds, dispatches each alert, and
    // trims, all in one write transaction. Notifier delivery is collected and
    // queued only after the transaction commits; a rollback delivers nothing.
    async recordFailedLogin(event, dispatcher = attached) {
      if (!dispatcher) throw new Error('Security event store has no alert dispatcher.');
      const deliveries = [];
      const result = await withWriteTx(sql, async t => {
        const stored = await insertEvent(event, t);
        const alerts = evaluateAlerts({
          event: stored, recent: await windowEvents(stored.at, t), lastAlertAt: await lastAlertAt(stored.username, t), rules
        });
        const created = [];
        for (const alert of alerts) created.push(await dispatcher.dispatch(alert, { executor: t, defer: fn => deliveries.push(fn) }));
        await trim(t);
        return { event: stored, alerts: created };
      });
      for (const deliver of deliveries) queueMicrotask(deliver);
      return result;
    },
    listAlerts: async (e = sql) => (await e`
      SELECT * FROM security_alerts WHERE acknowledged_at IS NULL ORDER BY at DESC, seq DESC`).map(toAlert),
    unacknowledgedCount: async (e = sql) => countOf(await e`SELECT COUNT(*) AS n FROM security_alerts WHERE acknowledged_at IS NULL`),
    listEvents: async (limit = SECURITY_EVENT_LIMITS.listEvents, e = sql) => (await e`
      SELECT at, client, username, reason FROM security_events ORDER BY at DESC, id DESC LIMIT ${limit}`).map(toEvent),
    async getAlert(id, e = sql) {
      if (typeof id !== 'string' || !ALERT_ID_RE.test(id)) return null;
      const [row] = await e`SELECT * FROM security_alerts WHERE id = ${id}`;
      return row ? toAlert(row) : null;
    },
    // True only when an unacknowledged alert with this ID existed and is now
    // acknowledged. The caller writes the audit row in the same transaction.
    async acknowledge(id, by, at = clock(), e = sql) {
      if (typeof id !== 'string' || !ALERT_ID_RE.test(id)) return false;
      const result = await e`UPDATE security_alerts SET acknowledged_at = ${at}, acknowledged_by = ${String(by ?? '')}
        WHERE id = ${id} AND acknowledged_at IS NULL`;
      return int(result.count ?? 0, 'count') === 1;
    }
  };
}
