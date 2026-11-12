// SQLite_Importer 匯入規劃（server/db/import-plan.js）的純函式測試，不需要 Database（task 18.4）。
import { describe, test, expect } from 'bun:test';
import {
  tableOrder, columnNames, requiredColumnNames, requiredTables, isOptionalTable, convertRow, compareCounts,
  IDENTITY_COLUMNS, ImportPlanError,
} from '../server/db/import-plan.js';

const NEW_TABLES = ['settings', 'receipt_ai_usage', 'security_events', 'security_alerts'];
const OLD_TABLES = ['users', 'sessions', 'trips', 'trip_members', 'invites', 'trip_deletions', 'audit', 'trip_ledgers'];

// 每個資料表的外鍵父表（取自 migrations/0001、0002）。
const PARENTS = {
  users: [], sessions: ['users'], trips: ['users'], trip_members: ['trips', 'users'], invites: ['trips', 'users'],
  trip_deletions: ['trips', 'users'], audit: [], trip_ledgers: ['trips', 'users'],
  settings: [], receipt_ai_usage: ['users'], security_events: [], security_alerts: [],
};

describe('import plan', () => {
  test('tableOrder lists the 0001 and 0002 tables with every parent before its children', () => {
    const order = tableOrder();
    expect(order).toEqual([...OLD_TABLES, ...NEW_TABLES]);
    for (const table of order) for (const parent of PARENTS[table]) expect(order.indexOf(parent)).toBeLessThan(order.indexOf(table));
  });

  test('only the 0002 tables are optional; a source must have the 0001 tables', () => {
    expect(requiredTables()).toEqual(OLD_TABLES);
    for (const table of NEW_TABLES) expect(isOptionalTable(table)).toBe(true);
    for (const table of OLD_TABLES) expect(isOptionalTable(table)).toBe(false);
    expect(() => isOptionalTable('schema_migrations')).toThrow(ImportPlanError);
  });

  test('invites gains used_at, used_by and id; only those are optional', () => {
    expect(columnNames('invites')).toEqual(['token_hash', 'trip_id', 'created_by', 'created_at', 'expires_at', 'revoked_at', 'used_at', 'used_by', 'id']);
    expect(requiredColumnNames('invites')).toEqual(['token_hash', 'trip_id', 'created_by', 'created_at', 'expires_at', 'revoked_at']);
    for (const table of tableOrder().filter(t => t !== 'invites')) expect(requiredColumnNames(table)).toEqual(columnNames(table));
    expect(columnNames('security_alerts')).not.toContain('seq');
  });

  test('an old invites row converts with NULL for the 0002 columns; a security-harden row keeps them', () => {
    const old = { token_hash: 'h', trip_id: 't', created_by: 'u', created_at: 1, expires_at: 2, revoked_at: null };
    expect(convertRow('invites', old)).toEqual(['h', 't', 'u', 1, 2, null, null, null, null]);
    expect(convertRow('invites', { ...old, used_at: 9_007_199_254_740_993n, used_by: 'u2', id: 'inv-1' }))
      .toEqual(['h', 't', 'u', 1, 2, null, 9_007_199_254_740_993n, 'u2', 'inv-1']);
    // A required column is still required.
    const { created_by, ...missing } = old;
    expect(() => convertRow('invites', missing)).toThrow(ImportPlanError);
  });

  test('new tables convert with their column types and constraints', () => {
    expect(convertRow('receipt_ai_usage', { id: 'r', at: 5, user_id: 'u', trip_id: 't', model_id: 'm', prompt_tokens: 1, completion_tokens: 2, outcome: 'success' }))
      .toEqual(['r', 5, 'u', 't', 'm', 1, 2, 'success']);
    expect(() => convertRow('receipt_ai_usage', { id: 'r', at: 5, user_id: 'u', trip_id: 't', model_id: 'm', prompt_tokens: 2 ** 31, completion_tokens: 2, outcome: 'success' }))
      .toThrow(/prompt_tokens/);
    expect(convertRow('security_alerts', {
      id: 'a', at: 1, kind: 'global', username: '(all)', client: 'c', count: 20, window_start: 0, window_end: 1, acknowledged_at: null, acknowledged_by: null,
    })).toEqual(['a', 1, 'global', '(all)', 'c', 20, 0, 1, null, null]);
    expect(() => convertRow('security_events', { id: 1, at: 1, client: null, username: 'u', reason: 'invalid_input' })).toThrow(/client/);
    // Error messages never carry the value.
    try { convertRow('settings', { key: 'k', value: 'secret-value', updated_at: 'x', updated_by: 'a' }); } catch (e) { expect(e.message).not.toContain('secret-value'); }
  });

  test('compareCounts treats a missing source table as 0 rows when the caller records it as 0', () => {
    const source = Object.fromEntries(tableOrder().map(t => [t, NEW_TABLES.includes(t) ? 0 : 3]));
    expect(compareCounts(source, { ...source })).toEqual([]);
    expect(compareCounts(source, { ...source, security_events: 1 })).toEqual([{ table: 'security_events', source: 0, target: 1 }]);
    const { settings, ...withoutSettings } = source;
    expect(compareCounts(withoutSettings, source)).toEqual([{ table: 'settings', source: null, target: 0 }]);
  });

  test('identity columns that need setval after import', () => {
    expect(IDENTITY_COLUMNS).toEqual([{ table: 'audit', column: 'id' }, { table: 'security_events', column: 'id' }]);
  });
});
