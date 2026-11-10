// 寫入交易（Requirement 11.3）。
// 每個寫入交易開頭取得全域 transaction 級 advisory lock，序列化所有寫入者，
// 語意等同現行 SQLite 的 `BEGIN IMMEDIATE`，保留「交易內重新檢查」邏輯的正確性。
// Bun.SQL 的 `sql.begin` 自動送出 BEGIN；callback 拋出例外時送出 ROLLBACK 並以該例外 reject，
// 正常結束時送出 COMMIT（依 https://bun.com/docs/runtime/sql 的 Transactions 一節）。
// advisory xact lock 於 COMMIT／ROLLBACK 時自動釋放。

/** 寫入交易的 advisory lock key（Migration_Runner 使用 726362，兩者不同）。 */
export const WRITE_LOCK_KEY = 726361;

/**
 * 在寫入交易內執行 fn(t)。fn 內所有查詢都必須使用 `t` 並 await
 * （Bun.SQL 查詢為 lazy；交易結束後才 await 的 `t` 查詢會以 ERR_POSTGRES_INVALID_TRANSACTION_STATE 失敗）。
 * @template T
 * @param {import('bun').SQL} sql 連線池
 * @param {(t: import('bun').TransactionSQL) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWriteTx(sql, fn) {
  if (typeof fn !== 'function') throw new TypeError('fn 必須是函式');
  return sql.begin(async t => {
    await t`SELECT pg_advisory_xact_lock(${WRITE_LOCK_KEY}::bigint)`;
    return fn(t);
  });
}
