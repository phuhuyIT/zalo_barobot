/**
 * sampleCaption.ts
 *
 * /task <link Facebook> không còn lấy caption từ preview Facebook.
 * Admin gửi một ảnh trong chat 1-1. Caption là chữ đã gõ, hoặc "Ảnh mẫu".
 * Khi task được tạo, ảnh đó luôn được lưu làm mẫu đối chiếu.
 * Ảnh còn được tính là minh chứng của admin_zca_uid khi uid đó
 * có trong cache thành viên của nhóm đã chọn.
 * Ảnh mẫu không bị ảnh nhóm gửi sau của cùng uid ghi đè.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getDatabase } from '../store';
import { getProofDir } from './env';
import { sniffImageKind } from './imageKind';
import { closeTaskIfQuotaReached } from './records/lifecycle';
import { kickTaskCompletionReport } from './records/report';
import { getTaskproofSetting } from './records/settings';
import { downloadImageBytes } from './worker/imageFetch';

export const SAMPLE_TTL_MS = 10 * 60 * 1000;

export const SAMPLE_CAPTION_FALLBACK = 'Ảnh mẫu';

export const SAMPLE_ASK_REPLY = [
  'Gửi một ảnh chụp bài viết vào chat này.',
  'Ảnh đó là mẫu để đối chiếu minh chứng, và được tính cho admin.',
].join('\n');

export const SAMPLE_NEED_PHOTO_REPLY = 'Cần một ảnh chụp bài, không phải tin chữ. Gửi ảnh vào chat này.';

export const SAMPLE_BAD_IMAGE_REPLY = 'Chỉ nhận JPEG, PNG hoặc WebP.';

export const SAMPLE_DOWNLOAD_FAIL_REPLY = 'Không tải được ảnh. Gửi lại.';

export interface SamplePending {
  adminChatId: string;
  link: string;
  requiredCount: number | null;
  deadline: number;
  reportGroupId: string;
  caption: string;
  imagePath: string;
  photoUrl: string;
  createdAt: number;
  expiresAt: number;
}

interface SampleRow {
  admin_chat_id: string;
  link: string;
  required_count: number | null;
  deadline: number;
  report_group_id: string;
  caption: string;
  image_path: string;
  photo_url: string;
  created_at: number;
  expires_at: number;
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

function mapRow(row: SampleRow): SamplePending {
  return {
    adminChatId: row.admin_chat_id,
    link: row.link,
    requiredCount: row.required_count,
    deadline: row.deadline,
    reportGroupId: row.report_group_id,
    caption: row.caption || '',
    imagePath: row.image_path || '',
    photoUrl: row.photo_url || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const SELECT_PENDING = `SELECT admin_chat_id, link, required_count, deadline, report_group_id,
            caption, image_path, photo_url, created_at, expires_at
     FROM task_sample_pending WHERE admin_chat_id = ?`;

function stripMemberId(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  const ver = value.match(/^(.+)_(\d+)$/);
  return ver ? ver[1] : value;
}

function sampleFilePath(adminChatId: string): string {
  const safe = (adminChatId || 'admin').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(getProofDir(), '_sample', `${safe}.bin`);
}

function deleteFile(filePath: string): void {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // file tạm — thiếu file không chặn lệnh
  }
}

export function clearSamplePending(adminChatId: string, database?: Database.Database): void {
  const db = dbOf(database);
  const row = db.prepare(SELECT_PENDING).get(adminChatId) as SampleRow | undefined;
  if (row?.image_path) deleteFile(row.image_path);
  db.prepare(`DELETE FROM task_sample_pending WHERE admin_chat_id = ?`).run(adminChatId);
}

export function saveAwaitingSample(
  input: {
    adminChatId: string;
    link: string;
    requiredCount: number | null;
    deadline: number;
    reportGroupId: string;
    now?: number;
  },
  database?: Database.Database
): SamplePending {
  const db = dbOf(database);
  clearSamplePending(input.adminChatId, db);
  const now = input.now ?? Date.now();
  const expiresAt = now + SAMPLE_TTL_MS;
  db.prepare(
    `INSERT INTO task_sample_pending (
       admin_chat_id, link, required_count, deadline, report_group_id,
       caption, image_path, photo_url, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?)`
  ).run(
    input.adminChatId,
    input.link,
    input.requiredCount,
    input.deadline > 0 ? input.deadline : 0,
    input.reportGroupId || '',
    now,
    expiresAt
  );
  return {
    adminChatId: input.adminChatId,
    link: input.link,
    requiredCount: input.requiredCount,
    deadline: input.deadline > 0 ? input.deadline : 0,
    reportGroupId: input.reportGroupId || '',
    caption: '',
    imagePath: '',
    photoUrl: '',
    createdAt: now,
    expiresAt,
  };
}

export function getOpenSample(
  adminChatId: string,
  now: number = Date.now(),
  database?: Database.Database
): SamplePending | null {
  const db = dbOf(database);
  const row = db.prepare(SELECT_PENDING).get(adminChatId) as SampleRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    clearSamplePending(adminChatId, db);
    return null;
  }
  return mapRow(row);
}

export function updateSampleCaption(
  adminChatId: string,
  caption: string,
  now: number = Date.now(),
  database?: Database.Database
): SamplePending | null {
  const db = dbOf(database);
  const pending = getOpenSample(adminChatId, now, db);
  if (!pending || !pending.imagePath) return null;
  const text = caption.trim();
  if (!text) return null;
  const expiresAt = now + SAMPLE_TTL_MS;
  db.prepare(
    `UPDATE task_sample_pending SET caption = ?, expires_at = ? WHERE admin_chat_id = ?`
  ).run(text, expiresAt, adminChatId);
  return { ...pending, caption: text, expiresAt };
}

export function writeAcceptedSample(
  adminChatId: string,
  image: Buffer,
  caption: string,
  photoUrl: string,
  now: number = Date.now(),
  database?: Database.Database
): SamplePending | null {
  const db = dbOf(database);
  const pending = getOpenSample(adminChatId, now, db);
  if (!pending) return null;
  const text = caption.trim();
  if (!text) return null;
  const dest = sampleFilePath(adminChatId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.next`;
  fs.writeFileSync(tmp, image);
  fs.renameSync(tmp, dest);
  if (pending.imagePath && pending.imagePath !== dest) deleteFile(pending.imagePath);
  const expiresAt = now + SAMPLE_TTL_MS;
  db.prepare(
    `UPDATE task_sample_pending
     SET caption = ?, image_path = ?, photo_url = ?, expires_at = ?
     WHERE admin_chat_id = ?`
  ).run(text, dest, photoUrl || '', expiresAt, adminChatId);
  return { ...pending, caption: text, imagePath: dest, photoUrl: photoUrl || '', expiresAt };
}

export async function downloadSampleImage(
  url: string,
  download: (url: string) => Promise<Buffer | null> = (raw) => downloadImageBytes(raw)
): Promise<{ ok: true; image: Buffer } | { ok: false; reply: string }> {
  const buf = await download(url);
  if (!buf || buf.length === 0) return { ok: false, reply: SAMPLE_DOWNLOAD_FAIL_REPLY };
  if (!sniffImageKind(buf)) return { ok: false, reply: SAMPLE_BAD_IMAGE_REPLY };
  return { ok: true, image: buf };
}

interface CachedMemberRow {
  user_id: string;
  display_name: string;
}

export function resolveAdminMember(
  zcaGroupId: string,
  database?: Database.Database
): { userId: string; displayName: string } | null {
  const configured = stripMemberId(getTaskproofSetting('admin_zca_uid', database));
  if (!configured || !zcaGroupId) return null;
  const rows = dbOf(database)
    .prepare(
      `SELECT user_id, display_name FROM group_members_cache WHERE zca_group_id = ?`
    )
    .all(zcaGroupId) as CachedMemberRow[];
  const hit = rows.find(
    (row) => row.user_id === configured || stripMemberId(row.user_id) === configured
  );
  if (!hit) return null;
  return { userId: hit.user_id, displayName: (hit.display_name || '').trim() || hit.user_id };
}

/**
 * Lưu ảnh mẫu làm file đối chiếu của task. Xóa pending dù có tính
 * cho admin hay không, để ảnh không dính sang task sau.
 * Trả câu gửi kèm tin xác nhận cho admin.
 */
export async function recordAdminSampleProof(
  input: {
    adminChatId: string;
    taskId: string;
    zcaGroupId: string;
    now?: number;
  },
  database?: Database.Database
): Promise<string> {
  const db = dbOf(database);
  const now = input.now ?? Date.now();
  const pending = getOpenSample(input.adminChatId, now, db);
  if (!pending || !pending.imagePath) return '';
  let image: Buffer;
  try {
    image = fs.readFileSync(pending.imagePath);
  } catch {
    clearSamplePending(input.adminChatId, db);
    return 'Không đọc được file ảnh mẫu nên chưa lưu mẫu đối chiếu.';
  }
  if (!sniffImageKind(image)) {
    clearSamplePending(input.adminChatId, db);
    return 'Ảnh mẫu không phải JPEG, PNG hoặc WebP nên chưa lưu mẫu đối chiếu.';
  }

  const dir = path.join(getProofDir(), input.taskId);
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, 'sample.jpg');
  fs.writeFileSync(storedPath, image);
  db.prepare(`UPDATE tasks SET sample_stored_path = ? WHERE id = ?`).run(storedPath, input.taskId);

  const member = resolveAdminMember(input.zcaGroupId, db);
  const photoUrl = pending.photoUrl || 'sample://admin';
  clearSamplePending(input.adminChatId, db);
  if (!member) {
    return [
      'Đã lưu ảnh mẫu để đối chiếu minh chứng.',
      'Chưa tính ảnh đó cho admin. Đặt UID thành viên nhóm vào ô "Admin zca UID" trên Web UI nếu muốn tính.',
    ].join(' ');
  }

  const submissionId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO submissions
       (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at, proof_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sample')`
  ).run(
    submissionId,
    input.taskId,
    member.userId,
    member.displayName,
    photoUrl,
    storedPath,
    1,
    now
  );

  const closed = closeTaskIfQuotaReached(db, input.taskId);
  if (closed) {
    try {
      await kickTaskCompletionReport(input.taskId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[TaskProof] kick báo cáo sau ảnh mẫu lỗi:', msg);
    }
  }
  return `Đã tính ảnh mẫu là minh chứng của ${member.displayName}.`;
}
