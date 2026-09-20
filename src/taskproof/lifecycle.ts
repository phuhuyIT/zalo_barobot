/**
 * lifecycle.ts
 *
 * Worker chỉ giữ zca-js online khi:
 *   status IN ('collecting','overdue') AND zca_group_id IS NOT NULL
 * Ngoại lệ: cửa /lienket pending hoặc QR đang chờ — ở đến hết timeout rồi xét lại.
 * Task chưa liên kết (zca_group_id NULL) không giữ worker online.
 * overdue không đóng task — chỉ lật status và bắt đầu nhắc.
 * Job stale (official bot): collecting|overdue già hơn TASK_STALE_AFTER_MS → /huy.
 * Quota (Step 9): distinct uid_from ≥ required_count → completed; không xóa proofs.
 * /dong (Step 10): completed, reported_at NULL — T6 gửi báo cáo rồi mới xóa proofs.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getProofDir } from './env';
import { getTaskproofSetting } from './settings';
import { listMissingTaskproofTables } from './store';

export interface KeepWorkerOnlineOpts {
  linkedOpenCount: number;
  pendingLink: boolean;
  qrInFlight: boolean;
}

export interface StaleCancelRow {
  id: string;
  short_code: string;
}

export interface OpenLinkedTaskRow {
  id: string;
  short_code: string;
  status: string;
  deadline: number;
  remind_count: number;
  reminded_at: number | null;
  zca_group_id: string;
}

export function shouldKeepWorkerOnline(opts: KeepWorkerOnlineOpts): boolean {
  if (opts.qrInFlight) return true;
  if (opts.pendingLink) return true;
  return opts.linkedOpenCount > 0;
}

export function isTaskStale(createdAt: number, now: number, staleAfterMs: number): boolean {
  return now - createdAt >= staleAfterMs;
}

/**
 * Điều kiện nhắc tự động. overdue không đóng task.
 */
export function shouldAutoRemind(opts: {
  status: string;
  deadline: number;
  remindCount: number;
  remindedAt: number | null;
  now: number;
  maxAutoReminders: number;
  reminderIntervalMs: number;
}): boolean {
  if (opts.status !== 'collecting' && opts.status !== 'overdue') return false;
  if (opts.now <= opts.deadline) return false;
  if (opts.remindCount >= opts.maxAutoReminders) return false;
  if (opts.remindedAt !== null && opts.now - opts.remindedAt < opts.reminderIntervalMs) {
    return false;
  }
  return true;
}

export function countLinkedOpenTasks(db: Database.Database): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE status IN ('collecting', 'overdue') AND zca_group_id IS NOT NULL`
      )
      .get() as { n: number };
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

export function markOverdueTasks(db: Database.Database, now: number): number {
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'overdue'
       WHERE status = 'collecting' AND deadline < ?`
    )
    .run(now);
  return Number(result.changes || 0);
}

export function listDueAutoReminders(
  db: Database.Database,
  now: number,
  opts: { maxAutoReminders: number; reminderIntervalMs: number }
): OpenLinkedTaskRow[] {
  const rows = db
    .prepare(
      `SELECT id, short_code, status, deadline, remind_count, reminded_at, zca_group_id
       FROM tasks
       WHERE status IN ('collecting', 'overdue') AND zca_group_id IS NOT NULL
       ORDER BY created_at ASC, id ASC`
    )
    .all() as OpenLinkedTaskRow[];

  return rows.filter((row) =>
    shouldAutoRemind({
      status: row.status,
      deadline: row.deadline,
      remindCount: row.remind_count,
      remindedAt: row.reminded_at,
      now,
      maxAutoReminders: opts.maxAutoReminders,
      reminderIntervalMs: opts.reminderIntervalMs,
    })
  );
}

export function deleteTaskProofDir(taskId: string, proofDir: string = getProofDir()): void {
  const dir = path.join(proofDir, taskId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort — file store là Step 9; report xóa sau reported_at (Step 10)
  }
}

export function countDistinctSubmitters(db: Database.Database, taskId: string): number {
  const row = db
    .prepare(`SELECT COUNT(DISTINCT uid_from) AS n FROM submissions WHERE task_id = ?`)
    .get(taskId) as { n: number };
  return Number(row?.n || 0);
}

/**
 * Quota: số uid_from khác nhau ≥ required_count → completed.
 * overdue không đóng task — chỉ quota /dong /huy /stale mới đóng.
 * Không xóa proofs ở đây (báo cáo T6 xóa sau reported_at).
 */
export function closeTaskIfQuotaReached(db: Database.Database, taskId: string): boolean {
  const task = db
    .prepare(`SELECT required_count, status FROM tasks WHERE id = ?`)
    .get(taskId) as { required_count: number; status: string } | undefined;
  if (!task) return false;
  if (task.status !== 'collecting' && task.status !== 'overdue') return false;
  if (countDistinctSubmitters(db, taskId) < task.required_count) return false;
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'completed'
       WHERE id = ? AND status IN ('collecting', 'overdue')`
    )
    .run(taskId);
  return Number(result.changes || 0) > 0;
}

/**
 * /dong: status=completed, để reported_at NULL — T6 gửi báo cáo rồi mới xóa proofs.
 */
export function completeTask(db: Database.Database, taskId: string): boolean {
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'completed'
       WHERE id = ? AND status IN ('collecting', 'overdue')`
    )
    .run(taskId);
  return Number(result.changes || 0) > 0;
}

/**
 * /huy: status=cancelled, không report, xóa proofs ngay.
 */
export function cancelTask(
  db: Database.Database,
  taskId: string,
  opts: { proofDir?: string } = {}
): boolean {
  const result = db
    .prepare(
      `UPDATE tasks SET status = 'cancelled'
       WHERE id = ? AND status IN ('collecting', 'overdue')`
    )
    .run(taskId);
  if (!result.changes) return false;
  deleteTaskProofDir(taskId, opts.proofDir ?? getProofDir());
  return true;
}

export function cancelStaleTasks(
  db: Database.Database,
  now: number,
  opts: { staleAfterMs?: number; proofDir?: string } = {}
): StaleCancelRow[] {
  try {
    if (listMissingTaskproofTables(db).length > 0) return [];
    const staleAfterMs = opts.staleAfterMs ?? getTaskproofSetting('task_stale_after_ms', db);
    const rows = db
      .prepare(
        `SELECT id, short_code, created_at FROM tasks
         WHERE status IN ('collecting', 'overdue')`
      )
      .all() as Array<{ id: string; short_code: string; created_at: number }>;

    const cancelled: StaleCancelRow[] = [];
    for (const row of rows) {
      if (!isTaskStale(row.created_at, now, staleAfterMs)) continue;
      if (cancelTask(db, row.id, { proofDir: opts.proofDir })) {
        cancelled.push({ id: row.id, short_code: row.short_code });
      }
    }
    return cancelled;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProof] stale-cancel bỏ qua (bảng chưa sẵn sàng?):', msg);
    return [];
  }
}
