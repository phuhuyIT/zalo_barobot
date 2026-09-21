/**
 * groupPick.ts
 *
 * Admin tạo /task trong chat 1-1. Nếu có nhiều nhóm đã /lienket,
 * bot gửi danh sách + URL chọn nhóm. Token trên URL là secret
 * (không nhét INTERNAL_API_KEY vào tin nhắn).
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getVietnamTimeParts } from '../sheets/dateUtils';
import { getDatabase } from '../store';
import { getPublicBaseUrl } from './env';
import { listGroupMaps } from './maps';
import { insertNewTask, InsertedTask, InsertTaskInput, resolveTaskDeadline } from './tasks';
import { ParsedTaskFields } from './commands/types';
import { postEnsureListening, EnsureListeningResponse } from './workerClient';

export const GROUP_PICK_TTL_MS = 10 * 60 * 1000;

export const GROUP_COMMAND_HINT =
  'Gõ /task, /tasks, /nhac, /huy, /dong, /quet trong chat riêng 1-1 với bot, không gõ trong nhóm.';

export const PRIVATE_NOT_ADMIN_HINT =
  'Chỉ admin được dùng lệnh task-proof trong chat riêng với bot.';

export const LIENKET_IN_GROUP_HINT =
  'Gõ /lienket trong nhóm nhiệm vụ (không chat riêng).';

export const NO_LINKED_GROUPS_HINT =
  'Chưa có nhóm liên kết. Gõ /lienket trong nhóm nhiệm vụ rồi /task lại.';

export interface LinkedGroup {
  official_chat_id: string;
  zca_group_id: string;
  display_name: string | null;
}

export interface GroupPickRow {
  token: string;
  admin_chat_id: string;
  link: string;
  reference_text: string;
  required_count: number | null;
  deadline: number;
  report_group_id: string;
  groups: LinkedGroup[];
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  chosen_official_chat_id: string | null;
}

export interface PlaceTaskDeps {
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  insertTask?: (input: InsertTaskInput) => InsertedTask;
  ensureListening?: (taskId?: string) => Promise<EnsureListeningResponse>;
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

export function groupLabel(group: LinkedGroup): string {
  const name = (group.display_name || '').trim();
  if (name) return name;
  const id = group.official_chat_id || '';
  return id.length > 12 ? `Nhóm ${id.slice(0, 8)}` : `Nhóm ${id || '?'}`;
}

export function listLinkedGroups(database?: Database.Database): LinkedGroup[] {
  return listGroupMaps(database).map((row) => ({
    official_chat_id: row.official_chat_id,
    zca_group_id: row.zca_group_id,
    display_name: row.display_name,
  }));
}

function parseGroupsJson(raw: string): LinkedGroup[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row === 'object')
      .map((row) => {
        const item = row as Record<string, unknown>;
        return {
          official_chat_id: String(item.official_chat_id || ''),
          zca_group_id: String(item.zca_group_id || ''),
          display_name: typeof item.display_name === 'string' ? item.display_name : null,
        };
      })
      .filter((row) => row.official_chat_id);
  } catch {
    return [];
  }
}

function mapPickRow(row: {
  token: string;
  admin_chat_id: string;
  link: string;
  reference_text: string;
  required_count: number | null;
  deadline: number;
  report_group_id: string;
  groups_json: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  chosen_official_chat_id: string | null;
}): GroupPickRow {
  return {
    token: row.token,
    admin_chat_id: row.admin_chat_id,
    link: row.link,
    reference_text: row.reference_text,
    required_count: row.required_count,
    deadline: row.deadline,
    report_group_id: row.report_group_id,
    groups: parseGroupsJson(row.groups_json),
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    chosen_official_chat_id: row.chosen_official_chat_id,
  };
}

export function fieldsFromPick(pick: GroupPickRow): ParsedTaskFields {
  return {
    link: pick.link,
    caption: pick.reference_text,
    requiredCount: pick.required_count,
    deadlineUtcMs: pick.deadline > 0 ? pick.deadline : null,
    reportGroupId: pick.report_group_id,
    needsUnfurl: false,
  };
}

export function createGroupPick(
  input: {
    adminChatId: string;
    fields: ParsedTaskFields;
    groups: LinkedGroup[];
    now?: number;
    ttlMs?: number;
    token?: string;
  },
  database?: Database.Database
): GroupPickRow {
  const db = dbOf(database);
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? GROUP_PICK_TTL_MS;
  const token = input.token || crypto.randomBytes(16).toString('hex');
  const expiresAt = now + ttl;

  db.prepare(`DELETE FROM task_group_picks WHERE admin_chat_id = ? AND consumed_at IS NULL`).run(
    input.adminChatId
  );

  db.prepare(
    `INSERT INTO task_group_picks (
       token, admin_chat_id, link, reference_text, required_count, deadline,
       report_group_id, groups_json, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    input.adminChatId,
    input.fields.link,
    input.fields.caption,
    input.fields.requiredCount,
    input.fields.deadlineUtcMs && input.fields.deadlineUtcMs > 0 ? input.fields.deadlineUtcMs : 0,
    input.fields.reportGroupId || '',
    JSON.stringify(input.groups),
    now,
    expiresAt
  );

  return {
    token,
    admin_chat_id: input.adminChatId,
    link: input.fields.link,
    reference_text: input.fields.caption,
    required_count: input.fields.requiredCount,
    deadline: input.fields.deadlineUtcMs && input.fields.deadlineUtcMs > 0 ? input.fields.deadlineUtcMs : 0,
    report_group_id: input.fields.reportGroupId || '',
    groups: input.groups,
    created_at: now,
    expires_at: expiresAt,
    consumed_at: null,
    chosen_official_chat_id: null,
  };
}

export function getGroupPick(token: string, database?: Database.Database): GroupPickRow | null {
  const row = dbOf(database)
    .prepare(
      `SELECT token, admin_chat_id, link, reference_text, required_count, deadline,
              report_group_id, groups_json, created_at, expires_at, consumed_at,
              chosen_official_chat_id
       FROM task_group_picks WHERE token = ?`
    )
    .get(token) as
    | {
        token: string;
        admin_chat_id: string;
        link: string;
        reference_text: string;
        required_count: number | null;
        deadline: number;
        report_group_id: string;
        groups_json: string;
        created_at: number;
        expires_at: number;
        consumed_at: number | null;
        chosen_official_chat_id: string | null;
      }
    | undefined;
  return row ? mapPickRow(row) : null;
}

export function getOpenGroupPickForAdmin(
  adminChatId: string,
  now: number = Date.now(),
  database?: Database.Database
): GroupPickRow | null {
  const row = dbOf(database)
    .prepare(
      `SELECT token, admin_chat_id, link, reference_text, required_count, deadline,
              report_group_id, groups_json, created_at, expires_at, consumed_at,
              chosen_official_chat_id
       FROM task_group_picks
       WHERE admin_chat_id = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(adminChatId, now) as
    | {
        token: string;
        admin_chat_id: string;
        link: string;
        reference_text: string;
        required_count: number | null;
        deadline: number;
        report_group_id: string;
        groups_json: string;
        created_at: number;
        expires_at: number;
        consumed_at: number | null;
        chosen_official_chat_id: string | null;
      }
    | undefined;
  return row ? mapPickRow(row) : null;
}

export function consumeGroupPick(
  token: string,
  officialChatId: string,
  now: number = Date.now(),
  database?: Database.Database
): GroupPickRow | null {
  const db = dbOf(database);
  const pick = getGroupPick(token, db);
  if (!pick) return null;
  if (pick.consumed_at) return null;
  if (pick.expires_at <= now) return null;
  const result = db
    .prepare(
      `UPDATE task_group_picks
       SET consumed_at = ?, chosen_official_chat_id = ?
       WHERE token = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .run(now, officialChatId, token, now);
  if (!result.changes) return null;
  return { ...pick, consumed_at: now, chosen_official_chat_id: officialChatId };
}

export function pickUrl(token: string, index1: number, publicBaseUrl?: string): string {
  const base = (publicBaseUrl ?? getPublicBaseUrl()).replace(/\/$/, '');
  return `${base}/taskproof/pick/${encodeURIComponent(token)}/${index1}`;
}

export function formatPickerMessage(
  pick: GroupPickRow,
  publicBaseUrl?: string
): string {
  const base = (publicBaseUrl ?? getPublicBaseUrl()).replace(/\/$/, '');
  const lines = ['Đã nhận /task. Chọn nhóm để gửi nhiệm vụ:'];
  pick.groups.forEach((group, i) => {
    const n = i + 1;
    lines.push('');
    lines.push(`${n}. ${groupLabel(group)}`);
    if (base) lines.push(pickUrl(pick.token, n, base));
  });
  lines.push('');
  if (base) {
    lines.push('Bấm link, hoặc trả lời số thứ tự. Link hết hạn sau 10 phút.');
  } else {
    lines.push('Trả lời số thứ tự (1, 2, …).');
  }
  return lines.join('\n');
}

export function formatVnDeadline(utcMs: number): string {
  const parts = getVietnamTimeParts(new Date(utcMs));
  return `${parts.dateDMY} ${parts.timeHM}`;
}

export function fieldSummary(fields: ParsedTaskFields): string[] {
  const soLuong = fields.requiredCount === null ? 'mặc định' : String(fields.requiredCount);
  const baoCao = fields.reportGroupId || 'mặc định';
  const han =
    fields.deadlineUtcMs && fields.deadlineUtcMs > 0
      ? `${formatVnDeadline(fields.deadlineUtcMs)} (Asia/Ho_Chi_Minh)`
      : 'mặc định (1 giờ sau khi tạo)';
  return [
    `• Link: ${fields.link}`,
    `• Caption: ${fields.caption}`,
    `• Số lượng: ${soLuong}`,
    `• Hạn chót: ${han}`,
    `• Báo cáo: ${baoCao}`,
  ];
}

export function formatGroupTaskPost(created: InsertedTask, fields: ParsedTaskFields): string {
  return [
    `Nhiệm vụ ${created.short_code}`,
    `Link: ${fields.link}`,
    `Caption: ${fields.caption}`,
    `Số lượng: ${created.required_count}`,
    `Hạn chót: ${formatVnDeadline(created.deadline)} (Asia/Ho_Chi_Minh)`,
    'Gửi ảnh chụp màn hình vào nhóm này làm minh chứng.',
  ].join('\n');
}

export function resolveGroupChoice(raw: string, groups: LinkedGroup[]): LinkedGroup | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const numbered = text.match(/^(\d{1,2})$/);
  if (numbered) {
    const index = parseInt(numbered[1], 10) - 1;
    return groups[index] || null;
  }
  const lower = text.toLowerCase();
  const byName = groups.filter((g) => groupLabel(g).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  const byId = groups.filter((g) => g.official_chat_id === text);
  if (byId.length === 1) return byId[0];
  return null;
}

function listenHint(listen: EnsureListeningResponse | null): string {
  if (!listen) return '';
  if (listen.state === 'qr_required') {
    return 'QR đang gửi admin. Quét xong, ảnh minh chứng trong nhóm sẽ được đọc.';
  }
  if (listen.state === 'login_failed' || listen.state === 'qr_timeout' || listen.status >= 400) {
    return listen.error
      ? `Worker chưa đăng nhập zca-js (${listen.state}: ${listen.error}).`
      : `Worker chưa sẵn sàng (${listen.state}).`;
  }
  return '';
}

/**
 * INSERT task vào nhóm đã chọn, đăng tin (kèm Link) trong nhóm, xác nhận 1-1.
 */
export async function placeTaskInGroup(
  fields: ParsedTaskFields,
  group: LinkedGroup,
  adminChatId: string,
  deps: PlaceTaskDeps
): Promise<InsertedTask> {
  const insert = deps.insertTask ?? ((input: InsertTaskInput) => insertNewTask(input));
  const ensureListening = deps.ensureListening ?? ((taskId?: string) => postEnsureListening(taskId));

  const deadlineUtcMs = resolveTaskDeadline(fields.deadlineUtcMs);
  const created = insert({
    officialChatId: group.official_chat_id,
    link: fields.link,
    referenceText: fields.caption,
    requiredCount: fields.requiredCount,
    deadlineUtcMs,
    reportGroupId: fields.reportGroupId,
  });

  const groupText = formatGroupTaskPost(created, fields);
  let groupPosted = true;
  try {
    await deps.sendMessage(group.official_chat_id, groupText);
  } catch (err: unknown) {
    groupPosted = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] Không gửi được task vào nhóm:', msg);
  }

  const lines = [
    `Đã tạo task ${created.short_code} và gửi vào nhóm ${groupLabel(group)}.`,
    ...fieldSummary({
      ...fields,
      requiredCount: created.required_count,
      deadlineUtcMs: created.deadline,
    }),
  ];
  if (!groupPosted) {
    lines.push('Không gửi được tin vào nhóm (bot có trong nhóm không?). Task vẫn lưu.');
  }
  if (!created.zca_group_id) {
    lines.push('Nhóm chưa liên kết zca-js. Gõ /lienket trong nhóm đó.');
  }

  let listen: EnsureListeningResponse | null = null;
  try {
    listen = await ensureListening(created.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProof] /task ensure-listening lỗi:', msg);
    lines.push('Worker không chạy. /gui vẫn dùng được. Task vẫn lưu — thử /nhac sau.');
    await deps.sendMessage(adminChatId, lines.join('\n'));
    return created;
  }

  const hint = listenHint(listen);
  if (hint) lines.push(hint);
  await deps.sendMessage(adminChatId, lines.join('\n'));
  return created;
}

export async function completePickByIndex(
  token: string,
  index1: number,
  deps: PlaceTaskDeps,
  now: number = Date.now(),
  database?: Database.Database
): Promise<
  | { ok: true; created: InsertedTask; group: LinkedGroup }
  | { ok: false; status: number; title: string; body: string }
> {
  const pick = getGroupPick(token, database);
  if (!pick) {
    return { ok: false, status: 404, title: 'Không tìm thấy', body: 'Link không hợp lệ.' };
  }
  if (pick.consumed_at) {
    return {
      ok: false,
      status: 409,
      title: 'Đã chọn rồi',
      body: 'Link này đã dùng. Xem tin nhắn từ bot trong chat riêng.',
    };
  }
  if (pick.expires_at <= now) {
    return { ok: false, status: 410, title: 'Hết hạn', body: 'Link hết hạn. Gõ /task lại trong chat riêng với bot.' };
  }
  const group = pick.groups[index1 - 1];
  if (!group) {
    return { ok: false, status: 400, title: 'Sai nhóm', body: 'Số thứ tự không khớp. Gõ /task lại.' };
  }
  const consumed = consumeGroupPick(token, group.official_chat_id, now, database);
  if (!consumed) {
    return {
      ok: false,
      status: 409,
      title: 'Đã chọn rồi',
      body: 'Link này đã dùng. Xem tin nhắn từ bot trong chat riêng.',
    };
  }
  const created = await placeTaskInGroup(fieldsFromPick(pick), group, pick.admin_chat_id, deps);
  return { ok: true, created, group };
}

export function pickResultHtml(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
body{font-family:sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
</style></head>
<body><h1>${safeTitle}</h1><p>${safeBody}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
