/**
 * memberCache.ts
 *
 * Cache thành viên nhóm zca-js (group_members_cache).
 * /nhac luôn refresh một lần. Listen chỉ refresh khi cache trống
 * hoặc già hơn MEMBER_CACHE_MAX_AGE_MS. Refresh lỗi mà còn cache
 * → giữ cache cũ, không chặn nhắc / đối chiếu ảnh.
 */

import Database from 'better-sqlite3';
import { getTaskproofSetting } from '../settings';
import { ZcaGroupInfoSnapshot, ZcaLoginPort, ZcaMemberProfile } from './zcaAdapter';

export interface CachedMember {
  user_id: string;
  display_name: string;
}

export const MEMBER_INFO_BATCH = 40;

/** Zalo `type` trên currentMems / profile: 0 người, 1 OA hoặc bot. Không phải quyền admin. */
export const ZALO_OA_ACCOUNT_TYPE = 1;

export function isBotAccountType(type: number | undefined): boolean {
  return type === ZALO_OA_ACCOUNT_TYPE;
}

export function botIdsFromMembers(
  members: Array<{ id: string; accountType?: number }>
): string[] {
  const ids = new Set<string>();
  for (const member of members) {
    if (!isBotAccountType(member.accountType)) continue;
    const id = stripMemberId(member.id);
    if (id) ids.add(id);
  }
  return [...ids];
}

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

/** Zalo đôi khi trả `uid_version` (`123_0`) trong memVerList. */
export function stripMemberId(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  const ver = value.match(/^(.+)_(\d+)$/);
  return ver ? ver[1] : value;
}

function addIds(out: Set<string>, ids: Iterable<string>): void {
  for (const raw of ids) {
    const id = stripMemberId(raw);
    if (id) out.add(id);
  }
}

export function idsFromGroupInfo(info: ZcaGroupInfoSnapshot): string[] {
  const out = new Set<string>();
  addIds(out, info.memberIds || []);
  addIds(out, info.memVerList || []);
  addIds(out, (info.currentMems || []).map((m) => m.id));
  addIds(out, info.adminIds || []);
  if (info.creatorId) addIds(out, [info.creatorId]);
  return [...out];
}

/** Ghi một uid đã thấy trong tin nhóm — bổ sung khi getGroupInfo trả list rỗng. */
export function observeMember(
  db: Database.Database,
  zcaGroupId: string,
  userId: string,
  displayName: string,
  now: number
): void {
  const uid = stripMemberId(userId);
  if (!zcaGroupId || !uid) return;
  const existingTs = cacheUpdatedAt(db, zcaGroupId);
  const stamp = existingTs ?? now;
  db.prepare(
    `INSERT INTO group_members_cache (zca_group_id, user_id, display_name, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(zca_group_id, user_id) DO UPDATE SET
       display_name = CASE
         WHEN excluded.display_name != excluded.user_id THEN excluded.display_name
         ELSE group_members_cache.display_name
       END`
  ).run(zcaGroupId, uid, (displayName || '').trim() || uid, stamp);
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
): Promise<{ names: Map<string, string>; bots: Array<{ id: string; accountType?: number }> }> {
  const names = new Map<string, string>();
  const bots: Array<{ id: string; accountType?: number }> = [];
  if (!port.getGroupMembersInfo) return { names, bots };
  for (let i = 0; i < ids.length; i += MEMBER_INFO_BATCH) {
    const batch = ids.slice(i, i + MEMBER_INFO_BATCH);
    try {
      const profiles: ZcaMemberProfile[] = await port.getGroupMembersInfo(batch);
      for (const profile of profiles) {
        const id = stripMemberId(profile.id);
        if (!id) continue;
        names.set(id, profile.displayName || id);
        if (isBotAccountType(profile.accountType)) bots.push({ id, accountType: profile.accountType });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProofWorker] getGroupMembersInfo batch lỗi:', msg);
    }
  }
  return { names, bots };
}

export interface RefreshMemberCacheResult {
  ok: boolean;
  usedStale: boolean;
  memberCount: number;
  botUids: string[];
  warning?: string;
}

/**
 * /nhac: forceRefresh = true.
 * Listen: chỉ khi cache trống / quá hạn.
 * Nhắc tự động: onlyWhenEmpty — không gọi getGroupInfo nếu đã có cache.
 */
export async function refreshMemberCache(opts: {
  db: Database.Database;
  port: ZcaLoginPort;
  zcaGroupId: string;
  now: number;
  forceRefresh: boolean;
  onlyWhenEmpty?: boolean;
  maxAgeMs?: number;
}): Promise<RefreshMemberCacheResult> {
  const { db, port, zcaGroupId, now, forceRefresh } = opts;
  const maxAgeMs = opts.maxAgeMs ?? getTaskproofSetting('member_cache_max_age_ms', db);
  const existing = listCachedMembers(db, zcaGroupId);

  if (!forceRefresh && opts.onlyWhenEmpty && existing.length > 0) {
    return { ok: true, usedStale: false, memberCount: existing.length, botUids: [] };
  }

  if (!forceRefresh && !isMemberCacheStale(db, zcaGroupId, now, maxAgeMs)) {
    return { ok: true, usedStale: false, memberCount: existing.length, botUids: [] };
  }

  if (!port.getGroupInfo) {
    if (existing.length > 0) {
      console.warn('[TaskProofWorker] Không gọi được getGroupInfo — giữ cache cũ', zcaGroupId);
      return { ok: true, usedStale: true, memberCount: existing.length, botUids: [] };
    }
    return { ok: false, usedStale: false, memberCount: 0, botUids: [] };
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
      return { ok: true, usedStale: true, memberCount: existing.length, botUids: [] };
    }
    return { ok: false, usedStale: false, memberCount: 0, botUids: [] };
  }

  const ids = idsFromGroupInfo(info);
  const ownId = stripMemberId(port.getOwnId?.() || '');
  const usableIds = ownId ? ids.filter((id) => id !== ownId) : ids;
  let warning: string | undefined;
  if (info.lockViewMember) {
    warning = `lockViewMember=1 for ${zcaGroupId}`;
    console.warn(`[TaskProofWorker] ${warning} — tài khoản phụ có thể không xem được thành viên.`);
  }
  if (info.hasMoreMember || (info.totalMember > 0 && ids.length < info.totalMember)) {
    const incomplete = `member list incomplete for ${zcaGroupId}: got ${ids.length}/${info.totalMember}`;
    warning = warning ? `${warning}; ${incomplete}` : incomplete;
    console.warn(`[TaskProofWorker] ${incomplete}`);
  }
  console.log(
    `[TaskProofWorker] getGroupInfo ${zcaGroupId}: ids=${ids.length} usable=${usableIds.length} total=${info.totalMember} hasMore=${info.hasMoreMember} lockViewMember=${info.lockViewMember} currentMems=${info.currentMems.length} memVerList=${(info.memVerList || []).length}`
  );

  if (usableIds.length === 0) {
    if (existing.length > 0) {
      console.warn('[TaskProofWorker] getGroupInfo không có thành viên dùng được — giữ cache cũ', zcaGroupId);
      return { ok: true, usedStale: true, memberCount: existing.length, botUids: [], warning };
    }
    return { ok: false, usedStale: false, memberCount: 0, botUids: [], warning };
  }

  const currentNames = new Map(
    info.currentMems.map((m) => [stripMemberId(m.id), m.dName || m.id])
  );
  const profiles = await fetchProfiles(port, ids);
  const botUids = [
    ...new Set([
      ...botIdsFromMembers(info.currentMems),
      ...botIdsFromMembers(profiles.bots),
    ]),
  ];
  const members: CachedMember[] = ids.map((id) => ({
    user_id: id,
    display_name: displayNameOf(id, profiles.names, currentNames),
  }));

  const incomplete =
    Boolean(info.lockViewMember) ||
    Boolean(info.hasMoreMember) ||
    (info.totalMember > 0 && ids.length < info.totalMember);
  if (incomplete && existing.length > 0) {
    const merged = new Map(existing.map((m) => [m.user_id, m]));
    for (const member of members) merged.set(member.user_id, member);
    replaceMemberCache(db, zcaGroupId, [...merged.values()], now);
  } else {
    replaceMemberCache(db, zcaGroupId, members, now);
  }

  if (info.name) {
    db.prepare(
      `UPDATE group_id_map SET display_name = COALESCE(?, display_name) WHERE zca_group_id = ?`
    ).run(info.name, zcaGroupId);
  }

  return { ok: true, usedStale: false, memberCount: members.length, botUids, warning };
}
