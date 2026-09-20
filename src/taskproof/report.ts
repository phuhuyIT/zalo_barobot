/**
 * report.ts
 *
 * T6 — báo cáo hoàn thành (official bot only, Section 8.6).
 * sendPhoto chỉ nhận URL https (không đường dẫn đĩa).
 * Một ảnh chết: log + bỏ qua, không hủy cả báo cáo.
 * Gửi thất bại tới report_group_id → gửi lại official_chat_id của nhóm task.
 * /huy (cancelled) không vào hàng đợi này. Xóa proofs sau khi set reported_at.
 */

import Database from 'better-sqlite3';
import { getVietnamTimeParts } from '../sheets/dateUtils';
import { getDatabase } from '../store';
import { ZaloClient } from '../core/zaloClient';
import { buildTokenGatedUrl, getProofDir } from './env';
import { deleteTaskProofDir } from './lifecycle';
import { listMissingTaskproofTables } from './store';

export interface ReportSubmission {
  id: string;
  uid_from: string;
  display_name: string;
  image_url: string;
  stored_path: string | null;
  match_score: number;
  created_at: number;
}

export interface UnreportedTask {
  id: string;
  short_code: string;
  official_chat_id: string;
  report_group_id: string;
  link: string;
  reference_text: string;
  required_count: number;
}

export interface ReportSendDeps {
  sendPhoto?: (chatId: string, photoUrl: string, caption?: string) => Promise<unknown>;
  sendMessage?: (chatId: string, text: string) => Promise<unknown>;
  proofFileUrl?: (submissionId: string) => string;
  proofDir?: string;
  now?: () => number;
  /** Chỉ task này — kick ngay khi đủ quota / /dong. Cron không truyền. */
  taskId?: string;
}

export interface TaskReportResult {
  taskId: string;
  shortCode: string;
  reported: boolean;
  photosSent: number;
  photosSkipped: number;
  destination: 'report_group' | 'fallback_group' | null;
  error?: string;
}

function dbOf(database?: Database.Database): Database.Database {
  return database || getDatabase();
}

/** Cùng process: kick HTTP + cron + /dong không gửi báo cáo hai lần. */
const inFlightReports = new Map<string, Promise<TaskReportResult>>();

export function resetReportInFlightForTests(): void {
  inFlightReports.clear();
}

function defaultSendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<unknown> {
  return new ZaloClient().sendPhoto(chatId, photoUrl, caption);
}

function defaultSendMessage(chatId: string, text: string): Promise<unknown> {
  return new ZaloClient().sendMessage(chatId, text);
}

export function listUnreportedCompletedTasks(
  database?: Database.Database,
  taskId?: string
): UnreportedTask[] {
  try {
    if (listMissingTaskproofTables(dbOf(database)).length > 0) return [];
    const db = dbOf(database);
    if (taskId) {
      return db
        .prepare(
          `SELECT id, short_code, official_chat_id, report_group_id, link, reference_text, required_count
           FROM tasks
           WHERE status = 'completed' AND reported_at IS NULL AND id = ?
           ORDER BY created_at ASC`
        )
        .all(taskId) as UnreportedTask[];
    }
    return db
      .prepare(
        `SELECT id, short_code, official_chat_id, report_group_id, link, reference_text, required_count
         FROM tasks
         WHERE status = 'completed' AND reported_at IS NULL
         ORDER BY created_at ASC`
      )
      .all() as UnreportedTask[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[TaskProof] list unreported bỏ qua:', msg);
    return [];
  }
}

export function listSubmissionsForTask(
  taskId: string,
  database?: Database.Database
): ReportSubmission[] {
  return dbOf(database)
    .prepare(
      `SELECT id, uid_from, display_name, image_url, stored_path, match_score, created_at
       FROM submissions WHERE task_id = ? ORDER BY created_at ASC`
    )
    .all(taskId) as ReportSubmission[];
}

export function formatCompletionSummary(task: UnreportedTask, submissions: ReportSubmission[]): string {
  const lines = [
    `Báo cáo hoàn thành task ${task.short_code}`,
    `Caption: ${task.reference_text}`,
    `Link: ${task.link}`,
    `Đã nộp: ${submissions.length}/${task.required_count}`,
  ];
  submissions.forEach((sub, i) => {
    const when = getVietnamTimeParts(new Date(sub.created_at));
    const score = Number.isFinite(sub.match_score) ? sub.match_score.toFixed(2) : '?';
    lines.push(
      `${i + 1}. ${sub.display_name} (${sub.uid_from}) — ${score} — ${when.dateDMY} ${when.timeHM}`
    );
  });
  if (submissions.length === 0) {
    lines.push('(Chưa có minh chứng.)');
  }
  return lines.join('\n');
}

function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}

async function sendOneProofPhoto(
  chatId: string,
  sub: ReportSubmission,
  shortCode: string,
  sendPhoto: (chatId: string, photoUrl: string, caption?: string) => Promise<unknown>,
  proofFileUrl: (submissionId: string) => string
): Promise<'ok' | 'skip'> {
  const caption = `${shortCode} — ${sub.display_name}`;
  const fileUrl = proofFileUrl(sub.id);
  if (isHttpsUrl(fileUrl)) {
    try {
      await sendPhoto(chatId, fileUrl, caption);
      return 'ok';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[TaskProof] sendPhoto file URL thất bại ${sub.id}:`, msg);
    }
  }
  if (isHttpsUrl(sub.image_url)) {
    try {
      await sendPhoto(chatId, sub.image_url, caption);
      return 'ok';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[TaskProof] sendPhoto CDN fallback thất bại ${sub.id}:`, msg);
    }
  }
  console.warn(`[TaskProof] Bỏ qua ảnh chết ${sub.id} (task ${shortCode})`);
  return 'skip';
}

async function deliverReportToChat(
  chatId: string,
  task: UnreportedTask,
  submissions: ReportSubmission[],
  deps: Required<Pick<ReportSendDeps, 'sendPhoto' | 'sendMessage'>> & {
    proofFileUrl: (id: string) => string;
  }
): Promise<{ photosSent: number; photosSkipped: number; summarySent: boolean; error?: string }> {
  let photosSent = 0;
  let photosSkipped = 0;
  for (const sub of submissions) {
    try {
      const outcome = await sendOneProofPhoto(
        chatId,
        sub,
        task.short_code,
        deps.sendPhoto,
        deps.proofFileUrl
      );
      if (outcome === 'ok') photosSent += 1;
      else photosSkipped += 1;
    } catch (err: unknown) {
      photosSkipped += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[TaskProof] Ảnh ${sub.id} lỗi, bỏ qua:`, msg);
    }
  }

  const summary = formatCompletionSummary(task, submissions);
  try {
    await deps.sendMessage(chatId, summary);
    return { photosSent, photosSkipped, summarySent: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TaskProof] sendMessage báo cáo thất bại tới ${chatId}:`, msg);
    return { photosSent, photosSkipped, summarySent: false, error: msg };
  }
}

function markReported(
  db: Database.Database,
  taskId: string,
  now: number,
  proofDir: string
): void {
  db.prepare(`UPDATE tasks SET reported_at = ? WHERE id = ?`).run(now, taskId);
  deleteTaskProofDir(taskId, proofDir);
}

function alreadyReportedResult(task: UnreportedTask): TaskReportResult {
  return {
    taskId: task.id,
    shortCode: task.short_code,
    reported: true,
    photosSent: 0,
    photosSkipped: 0,
    destination: null,
    error: 'already_reported',
  };
}

function isAlreadyReported(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(`SELECT status, reported_at FROM tasks WHERE id = ?`)
    .get(taskId) as { status: string; reported_at: number | null } | undefined;
  return !row || row.status !== 'completed' || row.reported_at != null;
}

/**
 * Gửi một task completed. Ảnh chết không hủy báo cáo.
 * report_group thất bại → gửi lại nhóm task (official_chat_id).
 * Kick ngay + cron cùng process: một lần gửi (in-flight + reported_at).
 */
export async function sendTaskCompletionReport(
  task: UnreportedTask,
  database?: Database.Database,
  deps: ReportSendDeps = {}
): Promise<TaskReportResult> {
  const existing = inFlightReports.get(task.id);
  if (existing) return existing;
  const run = sendTaskCompletionReportOnce(task, database, deps);
  inFlightReports.set(task.id, run);
  try {
    return await run;
  } finally {
    if (inFlightReports.get(task.id) === run) inFlightReports.delete(task.id);
  }
}

async function sendTaskCompletionReportOnce(
  task: UnreportedTask,
  database: Database.Database | undefined,
  deps: ReportSendDeps
): Promise<TaskReportResult> {
  const db = dbOf(database);
  if (isAlreadyReported(db, task.id)) return alreadyReportedResult(task);
  const sendPhoto = deps.sendPhoto ?? defaultSendPhoto;
  const sendMessage = deps.sendMessage ?? defaultSendMessage;
  const proofFileUrl = deps.proofFileUrl ?? ((id: string) => buildTokenGatedUrl(`/internal/taskproof/file/${id}`));
  const proofDir = deps.proofDir ?? getProofDir();
  const now = deps.now ?? Date.now;
  const submissions = listSubmissionsForTask(task.id, db);

  const sendDeps = { sendPhoto, sendMessage, proofFileUrl };
  const reportChatId = (task.report_group_id || '').trim();
  const fallbackChatId = (task.official_chat_id || '').trim();

  if (reportChatId) {
    const first = await deliverReportToChat(reportChatId, task, submissions, sendDeps);
    if (first.summarySent) {
      markReported(db, task.id, now(), proofDir);
      return {
        taskId: task.id,
        shortCode: task.short_code,
        reported: true,
        photosSent: first.photosSent,
        photosSkipped: first.photosSkipped,
        destination: 'report_group',
      };
    }
  }

  if (fallbackChatId && fallbackChatId !== reportChatId) {
    const second = await deliverReportToChat(fallbackChatId, task, submissions, sendDeps);
    if (second.summarySent) {
      markReported(db, task.id, now(), proofDir);
      return {
        taskId: task.id,
        shortCode: task.short_code,
        reported: true,
        photosSent: second.photosSent,
        photosSkipped: second.photosSkipped,
        destination: 'fallback_group',
        error: reportChatId ? 'report_group failed, used fallback' : undefined,
      };
    }
    return {
      taskId: task.id,
      shortCode: task.short_code,
      reported: false,
      photosSent: second.photosSent,
      photosSkipped: second.photosSkipped,
      destination: null,
      error: second.error || 'both destinations failed',
    };
  }

  return {
    taskId: task.id,
    shortCode: task.short_code,
    reported: false,
    photosSent: 0,
    photosSkipped: submissions.length,
    destination: null,
    error: 'no destination chat id',
  };
}

/**
 * Quét completed AND reported_at IS NULL. Lỗi một task không chặn các task còn lại.
 * deps.taskId: chỉ kick task vừa đóng (quota / /dong); cron không truyền.
 */
export async function reportUnreportedCompletedTasks(
  database?: Database.Database,
  deps: ReportSendDeps = {}
): Promise<TaskReportResult[]> {
  const db = dbOf(database);
  const results: TaskReportResult[] = [];
  for (const task of listUnreportedCompletedTasks(db, deps.taskId)) {
    try {
      results.push(await sendTaskCompletionReport(task, db, deps));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TaskProof] Báo cáo ${task.short_code} lỗi:`, msg);
      results.push({
        taskId: task.id,
        shortCode: task.short_code,
        reported: false,
        photosSent: 0,
        photosSkipped: 0,
        destination: null,
        error: msg,
      });
    }
  }
  return results;
}

/** Kick ngay sau quota / /dong. Cron phút vẫn quét phần còn lại. */
export async function kickTaskCompletionReport(
  taskId: string,
  database?: Database.Database,
  deps: ReportSendDeps = {}
): Promise<TaskReportResult[]> {
  return reportUnreportedCompletedTasks(database, { ...deps, taskId });
}
