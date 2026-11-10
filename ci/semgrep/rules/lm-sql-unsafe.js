// semgrep --test 範例：lm-sql-unsafe（不是可執行程式碼，僅供規則測試）。

async function bad(sql, tx, userId, table) {
  // ruleid: lm-sql-unsafe
  await sql.unsafe(`SELECT * FROM users WHERE id = '${userId}'`);
  // ruleid: lm-sql-unsafe
  await tx.unsafe('DELETE FROM ' + table);
  // ruleid: lm-sql-unsafe
  const run = sql.unsafe;
  return run;
}

async function good(sql, tx, userId) {
  // ok: lm-sql-unsafe
  await sql`SELECT * FROM users WHERE id = ${userId}`;
  // ok: lm-sql-unsafe
  await tx`UPDATE users SET deleted_at = ${Date.now()} WHERE id = ${userId}`;
  // ok: lm-sql-unsafe
  const unsafe = { note: 'a property named unsafe on a plain object literal is fine' };
  return unsafe;
}

export { bad, good };
