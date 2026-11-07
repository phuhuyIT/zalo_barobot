/**
 * members.ts
 *
 * Thành viên đã cache (group_members_cache), gắn với map nhóm nếu có.
 * Web UI dùng danh sách này để loại trừ bằng nút, không cần dán UID.
 * Official bot không import zca-js — chỉ đọc SQLite.
 */

import Database from 'better-sqlite3';
import { getDatabase } from '../../store';

export interface TaskproofMemberView {
  zca_group_id: string;
  official_chat_id: string | null;
  group_name: string | null;
  user_id: string;
  display_name: string;
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

export function listTaskproofMembers(database?: Database.Database): TaskproofMemberView[] {
  return dbOf(database)
    .prepare(
      `SELECT c.zca_group_id AS zca_group_id,
              g.official_chat_id AS official_chat_id,
              g.display_name AS group_name,
              c.user_id AS user_id,
              c.display_name AS display_name
       FROM group_members_cache c
       LEFT JOIN group_id_map g ON g.zca_group_id = c.zca_group_id
       ORDER BY COALESCE(NULLIF(g.display_name, ''), c.zca_group_id),
                c.display_name,
                c.user_id`
    )
    .all() as TaskproofMemberView[];
}
