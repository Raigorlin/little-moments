// 帳號、行程、邀請、稽核與帳本查詢（Requirement 11.1、11.2、11.3、11.7；design.md Components §4）。
//
// 每個函式對應原 SQLite 實作 `q.*` 的一個 prepared statement，第一個參數為 executor：
// 連線池 `sql`（交易外）或 `withWriteTx` 提供的交易 `t`（交易內）。交易內的查詢一律傳入 `t`。
//
// 規則：
// - 全部使用 Bun.SQL tagged template，值一律以參數傳遞；禁止 `sql.unsafe` 與字串拼接（Req 11.2）。
// - Bun.SQL 將 BIGINT 與 COUNT(*) 以字串回傳；`intRow` 以 Number() 轉換並檢查
//   Number.isSafeInteger，超出範圍即拋出（由 HTTP 層轉為 500），不靜默截斷。
// - `.get()` → 第一列或 null；`.all()` → 陣列；`.run().changes` → 回傳受影響列數（Bun.SQL `count`）。
// - state_json／ledger_json／requests_json 維持 TEXT，原樣讀寫。

/** 原 SQLite schema 中所有整數欄位（BIGINT 時間戳記、INTEGER 版本號與計數、COUNT(*) 結果）。 */
const INT_COLUMNS = new Set([
  'created_at', 'deleted_at', 'expires_at', 'joined_at', 'revoked_at', 'updated_at', 'at', 'used_at',
  'revision', 'people_count', 'trip_count', 'n',
  // receipt_ai_usage（migrations/0002）與其彙總結果
  'prompt_tokens', 'completion_tokens', 'requests', 'prompt', 'completion',
]);

/** 整數欄位轉換：null 保留；其餘須為安全整數。 */
export function toSafeInt(value, column = 'value') {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Database 欄位 ${column} 不是安全整數`);
  return n;
}

/** 將一列中的整數欄位轉為 number，其他欄位原樣保留（回傳新物件）。 */
export function intRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of Object.keys(out)) if (INT_COLUMNS.has(key)) out[key] = toSafeInt(out[key], key);
  return out;
}

const first = rows => intRow(rows[0] ?? null);
const all = rows => Array.from(rows, intRow);
const count = rows => toSafeInt(rows[0]?.n ?? 0, 'n');
const changes = result => toSafeInt(result?.count ?? 0, 'count');

// ---- users ----
export const userCount = async e => count(await e`SELECT COUNT(*) AS n FROM users`);
export const userById = async (e, id) => first(await e`SELECT * FROM users WHERE id = ${id}`);
export const userByName = async (e, username) => first(await e`SELECT * FROM users WHERE username = ${username}`);
export const insertUser = async (e, id, username, displayName, role, passwordHash, createdAt) => changes(await e`
  INSERT INTO users (id, username, display_name, role, password_hash, created_at)
  VALUES (${id}, ${username}, ${displayName}, ${role}, ${passwordHash}, ${createdAt})`);
export const activeAdmins = async e => count(await e`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL`);
export const listUsers = async e => all(await e`
  SELECT u.*, (SELECT COUNT(*) FROM trip_members m WHERE m.user_id = u.id
    AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = m.trip_id)) AS trip_count
  FROM users u ORDER BY u.created_at, u.username`);
export const updateUser = async (e, displayName, role, id) => changes(await e`
  UPDATE users SET display_name = ${displayName}, role = ${role} WHERE id = ${id} AND deleted_at IS NULL`);
export const softDelete = async (e, at, id) => changes(await e`UPDATE users SET deleted_at = ${at} WHERE id = ${id} AND deleted_at IS NULL`);
export const updatePassword = async (e, passwordHash, id) => changes(await e`
  UPDATE users SET password_hash = ${passwordHash} WHERE id = ${id} AND deleted_at IS NULL`);

// ---- sessions ----
export const sessionUser = async (e, tokenHash, at) => first(await e`
  SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ${tokenHash} AND s.expires_at > ${at} AND u.deleted_at IS NULL`);
export const insertSession = async (e, tokenHash, userId, createdAt, expiresAt) => changes(await e`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (${tokenHash}, ${userId}, ${createdAt}, ${expiresAt})`);
export const deleteSession = async (e, tokenHash) => changes(await e`DELETE FROM sessions WHERE token_hash = ${tokenHash}`);
export const deleteExpiredSessions = async (e, at) => changes(await e`DELETE FROM sessions WHERE expires_at <= ${at}`);
/**
 * 每位使用者最多保留 max 個 Session（含剛建立的 keepHash）。
 * SQLite 版以 `ORDER BY created_at DESC LIMIT ?` 選出保留集合，同毫秒建立的 Session 次序未定義；
 * 此處明確保留 keepHash，其餘依 created_at DESC、token_hash 排序取 max − 1 個，結果具決定性。
 */
export const trimSessions = async (e, userId, keepHash, max) => changes(await e`
  DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keepHash}
    AND token_hash NOT IN (
      SELECT token_hash FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keepHash}
      ORDER BY created_at DESC, token_hash LIMIT ${Math.max(0, max - 1)})`);
export const deleteUserSessions = async (e, userId) => changes(await e`DELETE FROM sessions WHERE user_id = ${userId}`);

// ---- trips ----
// TRIP_SELECT + LIVE 條件在每個查詢中逐字展開（不以字串組裝 SQL）。
export const tripById = async (e, id) => first(await e`
  SELECT t.*, u.username AS owner_username, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.owner_id
  WHERE t.id = ${id} AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = t.id)`);
export const anyTripById = async (e, id) => first(await e`
  SELECT t.*, u.username AS owner_username, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.owner_id
  WHERE t.id = ${id}`);
export const tripDeletion = async (e, tripId) => first(await e`SELECT 1 AS deleted FROM trip_deletions WHERE trip_id = ${tripId}`);
export const insertTripDeletion = async (e, tripId, deletedBy, at) => changes(await e`
  INSERT INTO trip_deletions (trip_id, deleted_by, deleted_at) VALUES (${tripId}, ${deletedBy}, ${at})`);
export const allTrips = async e => all(await e`
  SELECT t.*, u.username AS owner_username, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.owner_id
  WHERE NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = t.id)
  ORDER BY t.start_date DESC, t.created_at DESC`);
export const myTrips = async (e, userId) => all(await e`
  SELECT t.*, u.username AS owner_username, u.display_name AS owner_name FROM trips t JOIN users u ON u.id = t.owner_id
  WHERE (t.owner_id = ${userId} OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = t.id AND m.user_id = ${userId}))
    AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = t.id)
  ORDER BY t.start_date DESC, t.created_at DESC`);
export const ownedTrips = async (e, ownerId) => all(await e`SELECT id FROM trips WHERE owner_id = ${ownerId}`);
export const insertTrip = async (e, r) => changes(await e`
  INSERT INTO trips (id, owner_id, title, destination, start_date, end_date, description, note, cover_kind, status,
    revision, people_count, state_json, created_at, updated_at)
  VALUES (${r.id}, ${r.ownerId}, ${r.title}, ${r.destination}, ${r.startDate}, ${r.endDate}, ${r.description}, ${r.note},
    ${r.coverKind}, ${r.status}, ${r.revision}, ${r.peopleCount}, ${r.stateJson}, ${r.createdAt}, ${r.updatedAt})`);
/** 樂觀鎖更新：僅在 revision 仍為 expectedRevision 時寫入；回傳受影響列數。 */
export const updateTrip = async (e, r) => changes(await e`
  UPDATE trips SET owner_id = ${r.ownerId}, title = ${r.title}, destination = ${r.destination}, start_date = ${r.startDate},
    end_date = ${r.endDate}, description = ${r.description}, note = ${r.note}, cover_kind = ${r.coverKind}, status = ${r.status},
    revision = ${r.revision}, people_count = ${r.peopleCount}, state_json = ${r.stateJson}, updated_at = ${r.updatedAt}
  WHERE id = ${r.id} AND revision = ${r.expectedRevision}`);

// ---- trip_members ----
export const membership = async (e, tripId, userId) => first(await e`
  SELECT person_id FROM trip_members WHERE trip_id = ${tripId} AND user_id = ${userId}`);
export const membersOf = async (e, tripId) => all(await e`SELECT user_id, person_id FROM trip_members WHERE trip_id = ${tripId}`);
export const tripsOfMember = async (e, userId) => all(await e`SELECT trip_id, person_id FROM trip_members WHERE user_id = ${userId}`);
export const insertMember = async (e, tripId, userId, personId, joinedAt) => changes(await e`
  INSERT INTO trip_members (trip_id, user_id, person_id, joined_at) VALUES (${tripId}, ${userId}, ${personId}, ${joinedAt})`);
export const deleteMember = async (e, tripId, userId) => changes(await e`DELETE FROM trip_members WHERE trip_id = ${tripId} AND user_id = ${userId}`);

// ---- invites ----
// Active_Invite：未撤銷、未使用、未過期（單次使用的邀請連結）。
export const activeInvites = async (e, tripId, at) => count(await e`
  SELECT COUNT(*) AS n FROM invites WHERE trip_id = ${tripId} AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ${at}`);
export const activeInvitesByUser = async (e, tripId, userId, at) => count(await e`
  SELECT COUNT(*) AS n FROM invites WHERE trip_id = ${tripId} AND created_by = ${userId}
    AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ${at}`);
export const insertInvite = async (e, id, tokenHash, tripId, createdBy, createdAt, expiresAt) => changes(await e`
  INSERT INTO invites (id, token_hash, trip_id, created_by, created_at, expires_at)
  VALUES (${id}, ${tokenHash}, ${tripId}, ${createdBy}, ${createdAt}, ${expiresAt})`);
/**
 * 可使用的 token 列（不論 used_at，由呼叫端判斷）。建立者必須仍為主辦人、管理員或該行程的旅伴，
 * 且未被刪除；行程未刪除。附帶 inviter_name 供登出狀態的預覽使用。
 */
export const inviteForUse = async (e, tokenHash, at) => first(await e`
  SELECT i.*, u.display_name AS inviter_name FROM invites i
  JOIN users u ON u.id = i.created_by JOIN trips t ON t.id = i.trip_id
  WHERE i.token_hash = ${tokenHash} AND i.revoked_at IS NULL AND i.expires_at > ${at} AND u.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM trip_deletions d WHERE d.trip_id = i.trip_id)
    AND (t.owner_id = i.created_by OR u.role = 'admin'
         OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = i.trip_id AND m.user_id = i.created_by))`);
/** 標記為已使用；used_at 條件使第二次使用失敗（回傳 0）。 */
export const consumeInvite = async (e, at, userId, tokenHash) => changes(await e`
  UPDATE invites SET used_at = ${at}, used_by = ${userId}
  WHERE token_hash = ${tokenHash} AND used_at IS NULL AND revoked_at IS NULL`);
// Invite_List：不選取 token_hash、帳號 id 或 username。
export const listTripInvites = async (e, tripId, at) => all(await e`
  SELECT i.id, u.display_name AS creator_name, i.created_at, i.expires_at FROM invites i
  JOIN users u ON u.id = i.created_by
  WHERE i.trip_id = ${tripId} AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at > ${at}
  ORDER BY i.created_at DESC, i.id`);
export const listTripInvitesBy = async (e, tripId, at, userId) => all(await e`
  SELECT i.id, u.display_name AS creator_name, i.created_at, i.expires_at FROM invites i
  JOIN users u ON u.id = i.created_by
  WHERE i.trip_id = ${tripId} AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at > ${at} AND i.created_by = ${userId}
  ORDER BY i.created_at DESC, i.id`);
export const activeInviteById = async (e, id, tripId, at) => first(await e`
  SELECT id, created_by FROM invites
  WHERE id = ${id} AND trip_id = ${tripId} AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ${at}`);
export const revokeInviteById = async (e, at, id, tripId) => changes(await e`
  UPDATE invites SET revoked_at = ${at} WHERE id = ${id} AND trip_id = ${tripId} AND revoked_at IS NULL AND used_at IS NULL`);
export const revokeTripInvites = async (e, at, tripId) => changes(await e`
  UPDATE invites SET revoked_at = ${at} WHERE trip_id = ${tripId} AND revoked_at IS NULL`);
export const revokeInvitesBy = async (e, at, userId) => changes(await e`
  UPDATE invites SET revoked_at = ${at} WHERE created_by = ${userId} AND revoked_at IS NULL`);
/** 降級為 member 時：撤銷該帳號在「既非主辦人也非旅伴」的行程所建立的有效連結。 */
export const revokeInvitesWithoutRights = async (e, at, userId) => changes(await e`
  UPDATE invites SET revoked_at = ${at} WHERE created_by = ${userId} AND revoked_at IS NULL AND used_at IS NULL
    AND trip_id NOT IN (SELECT id FROM trips WHERE owner_id = ${userId})
    AND trip_id NOT IN (SELECT trip_id FROM trip_members WHERE user_id = ${userId})`);

// ---- settings ----
export const settingByKey = async (e, key) => first(await e`SELECT value, updated_at, updated_by FROM settings WHERE key = ${key}`);
export const upsertSetting = async (e, key, value, updatedAt, updatedBy) => changes(await e`
  INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${value}, ${updatedAt}, ${updatedBy})
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);

// ---- receipt_ai_usage ----
/** 使用者在 (since, ∞) 內的呼叫時間（遞增）。 */
export const usageUserTimes = async (e, userId, since) => (await e`
  SELECT at FROM receipt_ai_usage WHERE user_id = ${userId} AND at > ${since} ORDER BY at`).map(r => toSafeInt(r.at, 'at'));
export const usageCountSince = async (e, since) => count(await e`SELECT COUNT(*) AS n FROM receipt_ai_usage WHERE at >= ${since}`);
export const usageTotalsSince = async (e, since) => first(await e`
  SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion
  FROM receipt_ai_usage WHERE at >= ${since}`);
export const insertUsage = async (e, id, at, userId, tripId, modelId) => changes(await e`
  INSERT INTO receipt_ai_usage (id, at, user_id, trip_id, model_id, outcome)
  VALUES (${id}, ${at}, ${userId}, ${tripId}, ${modelId}, 'pending')`);
export const settleUsage = async (e, outcome, promptTokens, completionTokens, id) => changes(await e`
  UPDATE receipt_ai_usage SET outcome = ${outcome}, prompt_tokens = ${promptTokens}, completion_tokens = ${completionTokens}
  WHERE id = ${id}`);
export const trimUsage = async (e, before) => changes(await e`DELETE FROM receipt_ai_usage WHERE at < ${before}`);

// ---- audit ----
export const insertAudit = async (e, at, actor, action, target) => changes(await e`
  INSERT INTO audit (at, actor, action, target) VALUES (${at}, ${actor}, ${action}, ${target})`);
/** 只保留最新 keep 筆（以 id 遞減）；不足 keep 筆時子查詢為 NULL，不刪除任何列。 */
export const trimAudit = async (e, keep) => changes(await e`
  DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ${keep})`);
export const listAudit = async e => all(await e`SELECT at, actor, action, target FROM audit ORDER BY id DESC LIMIT 200`);

// ---- trip_ledgers ----
export const ledgerByTrip = async (e, tripId) => first(await e`SELECT * FROM trip_ledgers WHERE trip_id = ${tripId}`);
export const insertLedger = async (e, tripId, ledgerJson, requestsJson, updatedBy, updatedAt) => changes(await e`
  INSERT INTO trip_ledgers (trip_id, revision, ledger_json, requests_json, updated_by, updated_at)
  VALUES (${tripId}, 1, ${ledgerJson}, ${requestsJson}, ${updatedBy}, ${updatedAt})`);
export const updateLedger = async (e, ledgerJson, requestsJson, updatedBy, updatedAt, tripId, expectedRevision) => changes(await e`
  UPDATE trip_ledgers SET revision = revision + 1, ledger_json = ${ledgerJson}, requests_json = ${requestsJson},
    updated_by = ${updatedBy}, updated_at = ${updatedAt}
  WHERE trip_id = ${tripId} AND revision = ${expectedRevision}`);
export const updateLedgerPeople = async (e, ledgerJson, tripId, expectedRevision) => changes(await e`
  UPDATE trip_ledgers SET ledger_json = ${ledgerJson} WHERE trip_id = ${tripId} AND revision = ${expectedRevision}`);
