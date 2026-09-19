/**
 * memberCache.ts
 *
 * Cache thành viên nhóm zca-js (group_members_cache).
 * /nhac luôn refresh một lần. Listen chỉ refresh khi cache trống
 * hoặc già hơn MEMBER_CACHE_MAX_AGE_MS. Refresh lỗi mà còn cache
 * → giữ cache cũ, không chặn nhắc / OCR.
 */

import Database from 'better-sqlite3';
import { getTaskproofSetting } from '../settings';
import { ZcaGroupInfoSnapshot, ZcaLoginPort, ZcaMemberProfile } from './zcaAdapter';

export interface CachedMember {
  user_id: string;
  display_name: string;
}

export const MEMBER_INFO_BATCH = 40;

export function listCachedMembers(db: Database.Database, zcaGroupId: string): CachedMember[] {
  return db
    .prepare(
      `SELECT user_id, display_name FROM group_members_cache
       WHERE zca_group_id = ? ORDER BY user_id`
    )
    .all(zcaGroupId) as CachedMember[];
}

export function cacheUpdatedAt(db: Database.Database, zcaGroupId: string): number | null {
  const row = db
    .prepare(`SELECT MAX(updated_at) AS ts FROM group_members_cache WHERE zca_group_id = ?`)
    .get(zcaGroupId) as { ts: number | null } | undefined;
  return row?.ts ?? null;
}

export function isMemberCacheStale(
  db: Database.Database,
  zcaGroupId: string,
  now: number,
  maxAgeMs: number
): boolean {
  const ts = cacheUpdatedAt(db, zcaGroupId);
  if (ts === null) return true;
  return now - ts > maxAgeMs;
}

export function listLinkedOpenZcaGroups(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT zca_group_id AS id FROM tasks
       WHERE status IN ('collecting', 'overdue') AND zca_group_id IS NOT NULL`
    )
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id).filter(Boolean);
}

export function replaceMemberCache(
  db: Database.Database,
  zcaGroupId: string,
  members: CachedMember[],
  now: number
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM group_members_cache WHERE zca_group_id = ?`).run(zcaGroupId);
    const insert = db.prepare(
      `INSERT INTO group_members_cache (zca_group_id, user_id, display_name, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const member of members) {
      if (!member.user_id) continue;
      insert.run(zcaGroupId, member.user_id, member.display_name || member.user_id, now);
    }
  });
  tx();
}

function idsFromGroupInfo(info: ZcaGroupInfoSnapshot): string[] {
  if (info.memberIds.length > 0) return [...new Set(info.memberIds.filter(Boolean))];
  return [...new Set(info.currentMems.map((m) => m.id).filter(Boolean))];
}

function displayNameOf(
  id: string,
  profiles: Map<string, string>,
  currentMems: Map<string, string>
): string {
  return profiles.get(id) || currentMems.get(id) || id;
}

async function fetchProfiles(
  port: ZcaLoginPort,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!port.getGroupMembersInfo) return out;
  for (let i = 0; i < ids.length; i += MEMBER_INFO_BATCH) {
    const batch = ids.slice(i, i + MEMBER_INFO_BATCH);
    try {
      const profiles: ZcaMemberProfile[] = await port.getGroupMembersInfo(batch);
      for (const profile of profiles) {
        if (!profile.id) continue;
        out.set(profile.id, profile.displayName || profile.id);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] getGroupMembersInfo batch lỗi:', msg);
    }
  }
  return out;
}

export interface RefreshMemberCacheResult {
  ok: boolean;
  usedStale: boolean;
  memberCount: number;
  warning?: string;
}

/**
 * /nhac: forceRefresh = true. Listen: chỉ khi cache trống / quá hạn.
 */
export async function refreshMemberCache(opts: {
  db: Database.Database;
  port: ZcaLoginPort;
  zcaGroupId: string;
  now: number;
  forceRefresh: boolean;
  maxAgeMs?: number;
}): Promise<RefreshMemberCacheResult> {
  const { db, port, zcaGroupId, now, forceRefresh } = opts;
  const maxAgeMs = opts.maxAgeMs ?? getTaskproofSetting('member_cache_max_age_ms', db);
  const existing = listCachedMembers(db, zcaGroupId);

  if (!forceRefresh && !isMemberCacheStale(db, zcaGroupId, now, maxAgeMs)) {
    return { ok: true, usedStale: false, memberCount: existing.length };
  }

  if (!port.getGroupInfo) {
    if (existing.length > 0) {
      console.warn('[TaskProofWorker] Không gọi được getGroupInfo — giữ cache cũ', zcaGroupId);
      return { ok: true, usedStale: true, memberCount: existing.length };
    }
    return { ok: false, usedStale: false, memberCount: 0 };
  }

  let info: ZcaGroupInfoSnapshot | null = null;
  try {
    info = await port.getGroupInfo(zcaGroupId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TaskProofWorker] getGroupInfo lỗi (${zcaGroupId}):`, msg);
  }

  if (!info) {
    if (existing.length > 0) {
      console.warn('[TaskProofWorker] getGroupInfo thất bại — giữ cache cũ', zcaGroupId);
      return { ok: true, usedStale: true, memberCount: existing.length };
    }
    return { ok: false, usedStale: false, memberCount: 0 };
  }

  const ids = idsFromGroupInfo(info);
  let warning: string | undefined;
  if (info.hasMoreMember || (info.totalMember > 0 && ids.length < info.totalMember)) {
    warning = `member list incomplete for ${zcaGroupId}: got ${ids.length}/${info.totalMember}`;
    console.warn(`[TaskProofWorker] ${warning}`);
  }

  if (ids.length === 0) {
    if (existing.length > 0) {
      console.warn('[TaskProofWorker] getGroupInfo trả 0 id — không xóa cache', zcaGroupId);
      return { ok: true, usedStale: true, memberCount: existing.length, warning };
    }
    return { ok: false, usedStale: false, memberCount: 0, warning };
  }

  const currentNames = new Map(info.currentMems.map((m) => [m.id, m.dName || m.id]));
  const profiles = await fetchProfiles(port, ids);
  const members: CachedMember[] = ids.map((id) => ({
    user_id: id,
    display_name: displayNameOf(id, profiles, currentNames),
  }));

  replaceMemberCache(db, zcaGroupId, members, now);

  if (info.name) {
    db.prepare(
      `UPDATE group_id_map SET display_name = COALESCE(?, display_name) WHERE zca_group_id = ?`
    ).run(info.name, zcaGroupId);
  }

  return { ok: true, usedStale: false, memberCount: members.length, warning };
}
