/**
 * maps.ts
 *
 * group_id_map phía official bot / Web UI (không import zca-js).
 * Xóa map: zca_group_id = NULL trên task collecting|overdue của nhóm đó
 * — không hủy task.
 */

import Database from 'better-sqlite3';
import { getDatabase } from '../../store';

export interface GroupMapAdminRow {
  official_chat_id: string;
  zca_group_id: string;
  display_name: string | null;
  linked_at: number;
  linked_by_uid: string | null;
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

export function listGroupMaps(database?: Database.Database): GroupMapAdminRow[] {
  return dbOf(database)
    .prepare(
      `SELECT official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid
       FROM group_id_map ORDER BY linked_at DESC`
    )
    .all() as GroupMapAdminRow[];
}

export function groupMapConflict(
  officialChatId: string,
  zcaGroupId: string,
  database?: Database.Database
): string | null {
  const db = dbOf(database);
  const byOfficial = db
    .prepare(`SELECT zca_group_id FROM group_id_map WHERE official_chat_id = ?`)
    .get(officialChatId) as { zca_group_id: string } | undefined;
  if (byOfficial && byOfficial.zca_group_id !== zcaGroupId) {
    return `official_chat_id already mapped to ${byOfficial.zca_group_id}`;
  }
  const byZca = db
    .prepare(`SELECT official_chat_id FROM group_id_map WHERE zca_group_id = ?`)
    .get(zcaGroupId) as { official_chat_id: string } | undefined;
  if (byZca && byZca.official_chat_id !== officialChatId) {
    return `zca_group_id already mapped to ${byZca.official_chat_id}`;
  }
  return null;
}

export function saveGroupMap(
  officialChatId: string,
  zcaGroupId: string,
  displayName: string | null,
  database?: Database.Database,
  now: number = Date.now()
): { ok: true } | { ok: false; error: string } {
  const official = officialChatId.trim();
  const zca = zcaGroupId.trim();
  if (!official || !zca) {
    return { ok: false, error: 'official_chat_id and zca_group_id are required' };
  }
  const conflict = groupMapConflict(official, zca, database);
  if (conflict) return { ok: false, error: conflict };

  const db = dbOf(database);
  db.prepare(
    `INSERT INTO group_id_map (official_chat_id, zca_group_id, display_name, linked_at, linked_by_uid)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(official_chat_id) DO UPDATE SET
       zca_group_id = excluded.zca_group_id,
       display_name = COALESCE(excluded.display_name, group_id_map.display_name),
       linked_at = excluded.linked_at`
  ).run(official, zca, displayName, now);

  db.prepare(
    `UPDATE tasks SET zca_group_id = ?
     WHERE official_chat_id = ? AND status IN ('collecting', 'overdue')`
  ).run(zca, official);

  return { ok: true };
}

/**
 * Xóa map: task mở của nhóm đó về zca_group_id NULL, không cancelled.
 */
export function deleteGroupMap(
  officialChatId: string,
  database?: Database.Database
): boolean {
  const db = dbOf(database);
  const result = db.prepare(`DELETE FROM group_id_map WHERE official_chat_id = ?`).run(officialChatId);
  if (!result.changes) return false;
  db.prepare(
    `UPDATE tasks SET zca_group_id = NULL
     WHERE official_chat_id = ? AND status IN ('collecting', 'overdue')`
  ).run(officialChatId);
  return true;
}
