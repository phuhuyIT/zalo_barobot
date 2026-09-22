/**
 * tasks.ts
 *
 * Official bot: INSERT /task, liệt kê /tasks, đóng /dong.
 * short_code đúng 6 [A-Z0-9] — không cắt UUID. Retry khi trùng UNIQUE.
 * zca_group_id lấy từ group_id_map (có thể NULL — chưa liên kết).
 * report_group_id = BaoCao: hoặc default_report_group_id (official chat_id).
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDatabase } from '../store';
import { generateShortCode } from './commands/shortCode';
import { getTaskproofSetting } from './settings';
import { listMissingTaskproofTables } from './store';

export interface TaskListRow {
  id: string;
  short_code: string;
  official_chat_id: string;
  zca_group_id: string | null;
  report_group_id: string;
  link: string;
  reference_text: string;
  required_count: number;
  deadline: number;
  status: string;
  created_at: number;
  remind_count: number;
  reminded_at: number | null;
  reported_at: number | null;
  submitted_count: number;
  group_display_name?: string | null;
}

export interface InsertTaskInput {
  officialChatId: string;
  link: string;
  referenceText: string;
  requiredCount?: number | null;
  deadlineUtcMs: number;
  reportGroupId?: string;
  now?: number;
  id?: string;
  shortCode?: string;
}

export function resolveTaskDeadline(
  deadlineUtcMs: number | null | undefined,
  now: number = Date.now(),
  database?: Database.Database
): number {
  if (typeof deadlineUtcMs === 'number' && deadlineUtcMs > 0) return deadlineUtcMs;
  const offset = Number(getTaskproofSetting('default_deadline_offset_ms', database));
  const ms = Number.isFinite(offset) && offset > 0 ? offset : 3_600_000;
  return now + ms;
}

export interface InsertedTask {
  id: string;
  short_code: string;
  official_chat_id: string;
  zca_group_id: string | null;
  report_group_id: string;
  required_count: number;
  deadline: number;
  status: 'collecting';
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

export function lookupZcaGroupId(
  officialChatId: string,
  database?: Database.Database
): string | null {
  const row = dbOf(database)
    .prepare(`SELECT zca_group_id FROM group_id_map WHERE official_chat_id = ?`)
    .get(officialChatId) as { zca_group_id: string } | undefined;
  return row?.zca_group_id || null;
}

function isUniqueConstraint(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : String(err);
  return code.includes('CONSTRAINT') || /UNIQUE constraint failed/i.test(msg);
}

/**
 * Tạo task collecting. id = UUID; short_code 6 ký tự, retry nếu trùng.
 */
export function insertNewTask(input: InsertTaskInput, database?: Database.Database): InsertedTask {
  const db = dbOf(database);
  const now = input.now ?? Date.now();
  const requiredCount =
    input.requiredCount && input.requiredCount >= 1
      ? input.requiredCount
      : getTaskproofSetting('default_required_count', db);
  const reportGroupId =
    (input.reportGroupId || '').trim() || getTaskproofSetting('default_report_group_id', db) || '';
  const zcaGroupId = lookupZcaGroupId(input.officialChatId, db);
  const id = input.id || crypto.randomUUID();

  const maxAttempts = 8;
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const shortCode = (i === 0 && input.shortCode
      ? input.shortCode
      : generateShortCode()
    ).toUpperCase();
    try {
      db.prepare(
        `INSERT INTO tasks (
           id, short_code, official_chat_id, zca_group_id, report_group_id,
           link, reference_text, required_count, deadline, status, created_at, remind_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, 0)`
      ).run(
        id,
        shortCode,
        input.officialChatId,
        zcaGroupId,
        reportGroupId,
        input.link,
        input.referenceText,
        requiredCount,
        input.deadlineUtcMs,
        now
      );
      return {
        id,
        short_code: shortCode,
        official_chat_id: input.officialChatId,
        zca_group_id: zcaGroupId,
        report_group_id: reportGroupId,
        required_count: requiredCount,
        deadline: input.deadlineUtcMs,
        status: 'collecting',
      };
    } catch (err: unknown) {
      lastError = err;
      if (!isUniqueConstraint(err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Không sinh được short_code duy nhất');
}

const TASK_SELECT = `
  SELECT t.id, t.short_code, t.official_chat_id, t.zca_group_id, t.report_group_id,
         t.link, t.reference_text, t.required_count, t.deadline, t.status, t.created_at,
         t.remind_count, t.reminded_at, t.reported_at,
         m.display_name AS group_display_name,
         (SELECT COUNT(DISTINCT s.uid_from) FROM submissions s WHERE s.task_id = t.id) AS submitted_count
  FROM tasks t
  LEFT JOIN group_id_map m ON m.official_chat_id = t.official_chat_id
`;

export function listTasksForOfficialChat(
  officialChatId: string,
  database?: Database.Database,
  limit = 20
): TaskListRow[] {
  return dbOf(database)
    .prepare(`${TASK_SELECT} WHERE t.official_chat_id = ? ORDER BY t.created_at DESC LIMIT ?`)
    .all(officialChatId, limit) as TaskListRow[];
}

export function listRecentTasks(database?: Database.Database, limit = 30): TaskListRow[] {
  return dbOf(database)
    .prepare(`${TASK_SELECT} ORDER BY t.created_at DESC LIMIT ?`)
    .all(limit) as TaskListRow[];
}

/** /tasks trong chat 1-1: chỉ task còn đang thu hoặc quá hạn. */
export function listOpenTasks(database?: Database.Database, limit = 30): TaskListRow[] {
  return dbOf(database)
    .prepare(
      `${TASK_SELECT}
       WHERE t.status IN ('collecting', 'overdue')
       ORDER BY t.created_at DESC LIMIT ?`
    )
    .all(limit) as TaskListRow[];
}

function openStatusLabel(status: string): string {
  return status === 'overdue' ? 'quá hạn' : 'đang thu';
}

export function getTaskListRowById(taskId: string, database?: Database.Database): TaskListRow | null {
  const row = dbOf(database)
    .prepare(`${TASK_SELECT} WHERE t.id = ?`)
    .get(taskId) as TaskListRow | undefined;
  return row || null;
}

export function formatTasksListReply(rows: TaskListRow[]): string {
  const open = rows.filter((row) => row.status === 'collecting' || row.status === 'overdue');
  if (open.length === 0) return 'Không có task đang thu hoặc quá hạn.';
  const lines = ['Danh sách task:'];
  for (const row of open) {
    lines.push(
      `• ${row.short_code} — ${openStatusLabel(row.status)} — ${row.submitted_count}/${row.required_count}`
    );
    const link = (row.link || '').trim();
    if (link) lines.push(`  ${link}`);
  }
  return lines.join('\n');
}

export function taskproofTablesReady(database?: Database.Database): boolean {
  try {
    return listMissingTaskproofTables(dbOf(database)).length === 0;
  } catch {
    return false;
  }
}
