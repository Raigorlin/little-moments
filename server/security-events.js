// Failed-login events and Security_Alerts.
// The first part is pure: no database access. The database-backed store at the
// end of this file (createSecurityEventStore) is passed to createAlertDispatcher
// as `store`.

import { randomUUID } from 'node:crypto';

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
// store.insertAlert(alert) runs synchronously and returns the stored alert;
// the log line follows; notifiers run later in a microtask, each isolated, and
// are never awaited, so they cannot change or delay the caller's response.
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
    dispatch(alert) {
      const stored = store.insertAlert(alert);
      safeLog(formatAlertLine(stored));
      const snapshot = [...list];
      if (snapshot.length) queueMicrotask(() => deliver(stored, snapshot));
      return stored;
    },
    register(notifier) {
      if (typeof notifier !== 'function') throw new TypeError('Alert notifier must be a function.');
      list.push(notifier);
    }
  };
}

// ---------------------------------------------------------------------------
// Database part (Security_Event_Store).
//
// SECURITY_EVENTS_SCHEMA is appended to SCHEMA in server/accounts.js, so the
// tables are created with the rest of the Accounts_DB. They are separate from
// `audit`, so a flood of failed logins cannot push account actions out of it.

export const SECURITY_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client TEXT NOT NULL, username TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('invalid_input','rate_limited','deleted_account','bad_credentials'))
  );
  CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at);
  CREATE INDEX IF NOT EXISTS security_events_user_at ON security_events(username, at);
  CREATE TABLE IF NOT EXISTS security_alerts (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('username','global')),
    username TEXT NOT NULL, client TEXT NOT NULL, count INTEGER NOT NULL,
    window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, acknowledged_at INTEGER, acknowledged_by TEXT
  );
  CREATE INDEX IF NOT EXISTS security_alerts_open ON security_alerts(acknowledged_at, at);
`;

export const SECURITY_EVENT_LIMITS = Object.freeze({ maxEvents: 5000, maxAlerts: 1000, listEvents: 200 });

const ALERT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CLIENT_MAX = 64;

const toAlert = row => ({
  id: row.id, at: row.at, kind: row.kind, username: row.username, client: row.client, count: row.count,
  windowStart: row.window_start, windowEnd: row.window_end,
  acknowledgedAt: row.acknowledged_at ?? null, acknowledgedBy: row.acknowledged_by ?? null
});

// Dispatcher wiring: the store is created first and handed to
// createAlertDispatcher({ store }); the dispatcher is then attached with
// store.attachDispatcher(dispatcher). This avoids a circular constructor
// dependency (the dispatcher needs store.insertAlert, recordFailedLogin needs
// dispatcher.dispatch). recordFailedLogin also accepts a dispatcher argument,
// which tests can use instead of attaching one. With no dispatcher at all it
// throws, so no Security_Alert can be created outside the Alert_Dispatcher
// (Req 23.16).
//
// db: a bun:sqlite Database that already has SECURITY_EVENTS_SCHEMA applied.
// clock: () => epoch ms, used when an event carries no `at`.
export function createSecurityEventStore(db, clock = Date.now, {
  maxEvents = SECURITY_EVENT_LIMITS.maxEvents,
  maxAlerts = SECURITY_EVENT_LIMITS.maxAlerts,
  rules = ALERT_RULES
} = {}) {
  const q = {
    insertEvent: db.query('INSERT INTO security_events (at, client, username, reason) VALUES (?, ?, ?, ?)'),
    windowEvents: db.query('SELECT at, client, username, reason FROM security_events WHERE at > ? AND at <= ? ORDER BY at, id'),
    lastUserAlert: db.query("SELECT MAX(at) AS at FROM security_alerts WHERE kind = 'username' AND username = ?"),
    lastGlobalAlert: db.query("SELECT MAX(at) AS at FROM security_alerts WHERE kind = 'global'"),
    insertAlert: db.query(`INSERT INTO security_alerts (id, at, kind, username, client, count, window_start, window_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    alertById: db.query('SELECT * FROM security_alerts WHERE id = ?'),
    openAlerts: db.query('SELECT * FROM security_alerts WHERE acknowledged_at IS NULL ORDER BY at DESC, rowid DESC'),
    openCount: db.query('SELECT COUNT(*) AS n FROM security_alerts WHERE acknowledged_at IS NULL'),
    alertCount: db.query('SELECT COUNT(*) AS n FROM security_alerts'),
    recentEvents: db.query('SELECT at, client, username, reason FROM security_events ORDER BY at DESC, id DESC LIMIT ?'),
    acknowledge: db.query('UPDATE security_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL'),
    trimEvents: db.query('DELETE FROM security_events WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT ?)'),
    trimAcked: db.query(`DELETE FROM security_alerts WHERE rowid IN (SELECT rowid FROM security_alerts
      WHERE acknowledged_at IS NOT NULL ORDER BY at, rowid LIMIT ?)`),
    trimOpen: db.query(`DELETE FROM security_alerts WHERE rowid IN (SELECT rowid FROM security_alerts
      WHERE acknowledged_at IS NULL ORDER BY at, rowid LIMIT ?)`)
  };
  // Nested calls (inside a caller's tx) become savepoints in bun:sqlite.
  const tx = fn => db.transaction(fn).immediate();
  let attached = null;

  const insertEvent = ({ at, client, username, reason }) => {
    if (!EVENT_REASONS.includes(reason)) throw new TypeError('Unknown failed-login reason.');
    const event = {
      at: Number.isFinite(at) ? Math.trunc(at) : clock(),
      client: String(client ?? '').slice(0, CLIENT_MAX),
      username: eventUsername(username),
      reason
    };
    q.insertEvent.run(event.at, event.client, event.username, event.reason);
    return event;
  };

  // Events in (at - windowMs, at], the span evaluateAlerts expects.
  const windowEvents = at => q.windowEvents.all(at - rules.windowMs, at);

  // Keys match evaluateAlerts: 'username:<name>' and 'global'.
  const lastAlertAt = username => {
    const out = {};
    if (username && username !== INVALID_USERNAME) {
      const row = q.lastUserAlert.get(username);
      if (row?.at !== null && row?.at !== undefined) out[`username:${username}`] = row.at;
    }
    const global = q.lastGlobalAlert.get();
    if (global?.at !== null && global?.at !== undefined) out.global = global.at;
    return out;
  };

  // Called by the Alert_Dispatcher only.
  const insertAlert = alert => {
    const kind = alert.kind === 'global' ? 'global' : 'username';
    const row = {
      id: randomUUID(), at: alert.at, kind,
      username: kind === 'global' ? ALL_USERNAMES : eventUsername(alert.username),
      client: String(alert.client ?? '').slice(0, CLIENT_MAX),
      count: alert.count, window_start: alert.windowStart, window_end: alert.windowEnd
    };
    q.insertAlert.run(row.id, row.at, row.kind, row.username, row.client, row.count, row.window_start, row.window_end);
    return toAlert(row);
  };

  // Keeps the newest maxEvents events, and at most maxAlerts alerts, removing
  // acknowledged alerts (oldest first) before any unacknowledged one (Req 23.4).
  const trim = () => {
    q.trimEvents.run(maxEvents);
    let excess = q.alertCount.get().n - maxAlerts;
    if (excess > 0) {
      excess -= q.trimAcked.run(excess).changes;
      if (excess > 0) q.trimOpen.run(excess);
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
    // trims, all in one transaction. Notifier delivery is queued as a microtask
    // by the dispatcher, so it runs after this transaction commits.
    recordFailedLogin(event, dispatcher = attached) {
      if (!dispatcher) throw new Error('Security event store has no alert dispatcher.');
      return tx(() => {
        const stored = insertEvent(event);
        const alerts = evaluateAlerts({
          event: stored, recent: windowEvents(stored.at), lastAlertAt: lastAlertAt(stored.username), rules
        });
        const created = alerts.map(alert => dispatcher.dispatch(alert));
        trim();
        return { event: stored, alerts: created };
      });
    },
    listAlerts: () => q.openAlerts.all().map(toAlert),
    unacknowledgedCount: () => q.openCount.get().n,
    listEvents: (limit = SECURITY_EVENT_LIMITS.listEvents) => q.recentEvents.all(limit),
    getAlert: id => (typeof id === 'string' && ALERT_ID_RE.test(id) ? (r => (r ? toAlert(r) : null))(q.alertById.get(id)) : null),
    // True only when an unacknowledged alert with this ID existed and is now
    // acknowledged. The caller writes the audit row in the same transaction.
    acknowledge(id, by, at = clock()) {
      if (typeof id !== 'string' || !ALERT_ID_RE.test(id)) return false;
      return q.acknowledge.run(at, String(by ?? ''), id).changes === 1;
    }
  };
}
