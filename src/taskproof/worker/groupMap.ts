/**
 * groupMap.ts
 *
 * official_chat_id (webhook) ↔ zca_group_id (threadId zca-js).
 * Không đối chiếu ảnh nhóm chưa có trong bảng này (zca_group_id NULL trên task).
 */

import Database from 'better-sqlite3';

export interface GroupMapRow {
  official_chat_id: string;
  zca_group_id: string;
  display_name: string | null;
}

export function findMapByOfficial(
  db: Database.Database,
  officialChatId: string
): GroupMapRow | undefined {
  return db
    .prepare(
      `SELECT official_chat_id, zca_group_id, display_name FROM group_id_map WHERE official_chat_id = ?`
    )
    .get(officialChatId) as GroupMapRow | undefined;
}

export function findMapByZca(db: Database.Database, zcaGroupId: string): GroupMapRow | undefined {
  return db
    .prepare(
      `SELECT official_chat_id, zca_group_id, display_name FROM group_id_map WHERE zca_group_id = ?`
    )
    .get(zcaGroupId) as GroupMapRow | undefined;
}

/** Nhóm chưa map thì không chấm ảnh và không nhắc. */
export function isMappedZcaGroup(db: Database.Database, zcaGroupId: string): boolean {
  if (!zcaGroupId) return false;
  return Boolean(findMapByZca(db, zcaGroupId));
}

export function shouldScoreZcaGroup(db: Database.Database, zcaGroupId: string): boolean {
  if (!isMappedZcaGroup(db, zcaGroupId)) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE zca_group_id = ? AND status IN ('collecting', 'overdue')`
    )
    .get(zcaGroupId) as { n: number };
  return Number(row?.n || 0) > 0;
}

export function conflictForPair(
  db: Database.Database,
  officialChatId: string,
  zcaGroupId: string
): string | null {
  const byOfficial = findMapByOfficial(db, officialChatId);
  if (byOfficial && byOfficial.zca_group_id !== zcaGroupId) {
    return `official_chat_id already mapped to ${byOfficial.zca_group_id}`;
  }
  const byZca = findMapByZca(db, zcaGroupId);
  if (byZca && byZca.official_chat_id !== officialChatId) {
    return `zca_group_id already mapped to ${byZca.official_chat_id}`;
  }
  return null;
}

export function upsertGroupMap(
  db: Database.Database,
  officialChatId: string,
  zcaGroupId: string,
  displayName: string | null,
  now: number
): void {
  db.prepare(
    `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(official_chat_id) DO UPDATE SET
       zca_group_id = excluded.zca_group_id,
       display_name = COALESCE(excluded.display_name, group_id_map.display_name),
       linked_at = excluded.linked_at`
  ).run(officialChatId, zcaGroupId, displayName, now);

  db.prepare(
    `UPDATE tasks SET zca_group_id = ?
     WHERE official_chat_id = ? AND zca_group_id IS NULL
       AND status IN ('collecting', 'overdue')`
  ).run(zcaGroupId, officialChatId);
}
