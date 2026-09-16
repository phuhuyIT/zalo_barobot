/**
 * patrol.repository.ts
 *
 * Tầng lưu trữ SQLite cho tính năng đi tuần (Patrol Repository).
 * Quản lý trạng thái hàng ngày `patrol_daily_status` và danh sách thành viên `patrol_members`.
 */

import Database from 'better-sqlite3';
import { getDatabase, safeJsonParse } from '../store';
import { PatrolDailyStatus, PatrolMember } from './patrol.types';

/**
 * Khởi tạo cấu trúc các bảng liên quan đến Patrol.
 */
export function initPatrolTables(database: Database.Database): void {
  // 1. Bảng lưu trạng thái lịch đi tuần theo ngày (mỗi ngày là 1 bản ghi duy nhất)
  database.exec(`
    CREATE TABLE IF NOT EXISTS patrol_daily_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE, -- DD/MM/YYYY (theo giờ Asia/Ho_Chi_Minh)
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      leader_user_id TEXT NOT NULL,
      submitted INTEGER NOT NULL DEFAULT 0, -- 1: Đã nộp hợp lệ, 0: Chưa nộp
      selected_members TEXT, -- JSON mảng chuỗi tên thành viên
      raw_message TEXT,
      message_id TEXT,
      received_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      last_reminder_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'submitted' | 'cancelled'
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 2. Bảng danh sách thành viên Tiểu đội 1 (cho phép xem/sửa trên Web UI)
  database.exec(`
    CREATE TABLE IF NOT EXISTS patrol_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL UNIQUE,
      aliases TEXT, -- JSON mảng chuỗi biệt danh / tên không dấu
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * Lấy trạng thái đi tuần của một ngày cụ thể (DD/MM/YYYY).
 */
export function getPatrolDailyStatus(
  date: string,
  database?: Database.Database
): PatrolDailyStatus | null {
  const d = database || getDatabase();
  const row = d
    .prepare(
      `SELECT id, date, group_id, sender_id, leader_user_id, submitted,
              selected_members, raw_message, message_id, received_at,
              reminder_count, last_reminder_at, status, created_at, updated_at
       FROM patrol_daily_status
       WHERE date = ?`
    )
    .get(date) as any;

  if (!row) return null;

  const members: string[] = safeJsonParse<string[]>(row.selected_members, []);

  return {
    id: row.id,
    date: row.date,
    groupId: row.group_id,
    senderId: row.sender_id,
    leaderUserId: row.leader_user_id,
    submitted: Boolean(row.submitted),
    selectedMembers: members,
    rawMessage: row.raw_message || undefined,
    messageId: row.message_id || undefined,
    receivedAt: row.received_at || undefined,
    reminderCount: row.reminder_count || 0,
    lastReminderAt: row.last_reminder_at || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lưu hoặc cập nhật việc nộp lịch đi tuần của Tiểu đội 1.
 */
export function savePatrolSubmission(
  params: {
    date: string;
    groupId: string;
    senderId: string;
    leaderUserId: string;
    selectedMembers: string[];
    rawMessage?: string;
    messageId?: string;
    receivedAt?: string;
  },
  database?: Database.Database
): PatrolDailyStatus {
  const d = database || getDatabase();
  const now = new Date().toISOString();
  const receivedAt = params.receivedAt || now;
  const membersJson = JSON.stringify(params.selectedMembers);

  const existing = getPatrolDailyStatus(params.date, d);

  if (existing) {
    d.prepare(
      `UPDATE patrol_daily_status
       SET group_id = ?,
           sender_id = ?,
           leader_user_id = ?,
           submitted = 1,
           selected_members = ?,
           raw_message = ?,
           message_id = ?,
           received_at = ?,
           status = 'submitted',
           updated_at = ?
       WHERE date = ?`
    ).run(
      params.groupId,
      params.senderId,
      params.leaderUserId,
      membersJson,
      params.rawMessage || null,
      params.messageId || null,
      receivedAt,
      now,
      params.date
    );
  } else {
    d.prepare(
      `INSERT INTO patrol_daily_status (
         date, group_id, sender_id, leader_user_id, submitted,
         selected_members, raw_message, message_id, received_at,
         reminder_count, last_reminder_at, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, NULL, 'submitted', ?, ?)`
    ).run(
      params.date,
      params.groupId,
      params.senderId,
      params.leaderUserId,
      membersJson,
      params.rawMessage || null,
      params.messageId || null,
      receivedAt,
      now,
      now
    );
  }

  return getPatrolDailyStatus(params.date, d)!;
}

/**
 * Cập nhật số lần nhắc nhở và thời gian nhắc nhở gần nhất.
 */
export function updatePatrolReminder(
  params: {
    date: string;
    groupId: string;
    leaderUserId: string;
    reminderCount: number;
    lastReminderAt: string;
  },
  database?: Database.Database
): PatrolDailyStatus {
  const d = database || getDatabase();
  const now = new Date().toISOString();

  const existing = getPatrolDailyStatus(params.date, d);

  if (existing) {
    d.prepare(
      `UPDATE patrol_daily_status
       SET reminder_count = ?,
           last_reminder_at = ?,
           updated_at = ?
       WHERE date = ?`
    ).run(params.reminderCount, params.lastReminderAt, now, params.date);
  } else {
    d.prepare(
      `INSERT INTO patrol_daily_status (
         date, group_id, sender_id, leader_user_id, submitted,
         selected_members, reminder_count, last_reminder_at, status,
         created_at, updated_at
       ) VALUES (?, ?, '', ?, 0, '[]', ?, ?, 'pending', ?, ?)`
    ).run(
      params.date,
      params.groupId,
      params.leaderUserId,
      params.reminderCount,
      params.lastReminderAt,
      now,
      now
    );
  }

  return getPatrolDailyStatus(params.date, d)!;
}

/**
 * Quản lý danh sách thành viên Tiểu đội 1 (CRUD).
 */
export function getPatrolMembers(database?: Database.Database): PatrolMember[] {
  const d = database || getDatabase();
  try {
    const rows = d
      .prepare(`SELECT id, full_name, aliases, created_at FROM patrol_members ORDER BY id ASC`)
      .all() as any[];

    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      aliases: safeJsonParse<string[]>(r.aliases, []),
      createdAt: r.created_at,
    }));
  } catch (err: unknown) {
    console.error('[PatrolRepo] Lỗi đọc danh sách patrol_members:', err);
    return [];
  }
}

export function addPatrolMember(
  fullName: string,
  aliases: string[] = [],
  database?: Database.Database
): PatrolMember {
  const d = database || getDatabase();
  const now = new Date().toISOString();
  const trimmedName = fullName.trim();
  const aliasesJson = JSON.stringify(aliases.map((a) => a.trim()).filter((a) => a.length > 0));

  const res = d
    .prepare(
      `INSERT INTO patrol_members (full_name, aliases, created_at)
       VALUES (?, ?, ?)`
    )
    .run(trimmedName, aliasesJson, now);

  return {
    id: Number(res.lastInsertRowid),
    fullName: trimmedName,
    aliases,
    createdAt: now,
  };
}

export function updatePatrolMember(
  id: number,
  fullName: string,
  aliases: string[] = [],
  database?: Database.Database
): boolean {
  const d = database || getDatabase();
  const trimmedName = fullName.trim();
  const aliasesJson = JSON.stringify(aliases.map((a) => a.trim()).filter((a) => a.length > 0));

  const res = d
    .prepare(
      `UPDATE patrol_members
       SET full_name = ?, aliases = ?
       WHERE id = ?`
    )
    .run(trimmedName, aliasesJson, id);

  return res.changes > 0;
}

export function deletePatrolMember(id: number, database?: Database.Database): boolean {
  const d = database || getDatabase();
  const res = d.prepare(`DELETE FROM patrol_members WHERE id = ?`).run(id);
  return res.changes > 0;
}
