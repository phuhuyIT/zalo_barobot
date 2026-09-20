/**
 * proofIngest.ts
 *
 * Hàng đợi minh chứng (Section 8.2): pre-filter → tải bytes → OCR
 * (single-flight trong ocr.ts) → chấm mọi task mở trên nhóm → ghi file
 * + submissions → đóng khi đủ quota.
 *
 * Ghi processed_messages trước OCR: crash giữa chừng không OCR lại
 * (at-most-once). Ảnh dưới ngưỡng: không row, không đổi task.
 * UNIQUE(task_id, uid_from) ghi đè lần nộp trước, không lưu lịch sử.
 * Worker không gửi báo cáo (T6 = official bot, Step 10).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getProofDir } from '../env';
import { closeTaskIfQuotaReached } from '../lifecycle';
import { getTaskproofSetting } from '../settings';
import { shouldOcrZcaGroup } from './groupMap';
import { downloadProofBytes } from './imageFetch';
import { MatchCandidate, pickBestMatch } from './match';
import { ocrImage as defaultOcrImage } from './ocr';
import { loadSession, ZcaCredentials } from './session';

export interface ProofImage {
  threadId: string;
  msgId: string;
  uidFrom: string;
  displayName: string;
  href?: string;
  thumb?: string;
}

export interface ProofIngestDeps {
  now?: () => number;
  ocrImage?: (image: Buffer) => Promise<string>;
  downloadImage?: (url: string) => Promise<Buffer | null>;
  loadSession?: () => ZcaCredentials | null;
  proofDir?: string;
  newId?: () => string;
}

export type ProofIngestResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'discarded'; reason: string }
  | {
      outcome: 'recorded';
      taskId: string;
      shortCode?: string;
      submissionId: string;
      storedPath: string;
      score: number;
      closed: boolean;
    };

interface OpenTaskRow {
  id: string;
  short_code: string;
  reference_text: string;
  created_at: number;
}

function alreadyProcessed(db: Database.Database, zcaGroupId: string, msgId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM processed_messages WHERE zca_group_id = ? AND msg_id = ?`
    )
    .get(zcaGroupId, msgId) as { ok: number } | undefined;
  return Boolean(row);
}

/** Trả true nếu claim thành công (chưa thấy msg này). */
export function claimProcessedMessage(
  db: Database.Database,
  zcaGroupId: string,
  msgId: string,
  now: number
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO processed_messages (zca_group_id, msg_id, created_at)
       VALUES (?, ?, ?)`
    )
    .run(zcaGroupId, msgId, now);
  return Number(result.changes || 0) > 0;
}

function listOpenCandidates(db: Database.Database, zcaGroupId: string): OpenTaskRow[] {
  return db
    .prepare(
      `SELECT id, short_code, reference_text, created_at FROM tasks
       WHERE zca_group_id = ? AND status IN ('collecting', 'overdue')
       ORDER BY created_at ASC, id ASC`
    )
    .all(zcaGroupId) as OpenTaskRow[];
}

function findExistingSubmission(
  db: Database.Database,
  taskId: string,
  uidFrom: string
): { id: string; stored_path: string | null } | undefined {
  return db
    .prepare(`SELECT id, stored_path FROM submissions WHERE task_id = ? AND uid_from = ?`)
    .get(taskId, uidFrom) as { id: string; stored_path: string | null } | undefined;
}

function writeProofFile(proofDir: string, taskId: string, submissionId: string, buf: Buffer): string {
  const dir = path.join(proofDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, `${submissionId}.jpg`);
  fs.writeFileSync(storedPath, buf);
  return storedPath;
}

function upsertSubmission(
  db: Database.Database,
  row: {
    id: string;
    taskId: string;
    uidFrom: string;
    displayName: string;
    imageUrl: string;
    storedPath: string;
    matchScore: number;
    createdAt: number;
  }
): void {
  db.prepare(
    `INSERT INTO submissions
       (id, task_id, uid_from, display_name, image_url, stored_path, match_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, uid_from) DO UPDATE SET
       display_name = excluded.display_name,
       image_url = excluded.image_url,
       stored_path = excluded.stored_path,
       match_score = excluded.match_score,
       created_at = excluded.created_at`
  ).run(
    row.id,
    row.taskId,
    row.uidFrom,
    row.displayName,
    row.imageUrl,
    row.storedPath,
    row.matchScore,
    row.createdAt
  );
}

export async function ingestProofImage(
  db: Database.Database,
  image: ProofImage,
  deps: ProofIngestDeps = {}
): Promise<ProofIngestResult> {
  const now = deps.now ?? Date.now;
  const proofDir = deps.proofDir ?? getProofDir();
  const ocr = deps.ocrImage ?? defaultOcrImage;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const zcaGroupId = (image.threadId || '').trim();
  const msgId = (image.msgId || '').trim();
  const uidFrom = (image.uidFrom || '').trim();
  if (!zcaGroupId || !msgId || !uidFrom) {
    return { outcome: 'skipped', reason: 'missing_ids' };
  }
  if (!shouldOcrZcaGroup(db, zcaGroupId)) {
    return { outcome: 'skipped', reason: 'unmapped_or_closed' };
  }
  if (alreadyProcessed(db, zcaGroupId, msgId)) {
    return { outcome: 'skipped', reason: 'already_processed' };
  }

  const session = deps.loadSession ? deps.loadSession() : loadSession();
  const downloaded = await downloadProofBytes(image.href, image.thumb, {
    session,
    download: deps.downloadImage,
  });
  if (!downloaded) {
    return { outcome: 'discarded', reason: 'fetch_failed' };
  }

  // Ghi trước OCR — crash giữa recognize không chạy lại cùng msg.
  if (!claimProcessedMessage(db, zcaGroupId, msgId, now())) {
    return { outcome: 'skipped', reason: 'already_processed' };
  }

  let ocrText: string;
  try {
    ocrText = await ocr(downloaded.buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProofWorker] OCR lỗi (đã claim processed, không retry):', msg);
    return { outcome: 'discarded', reason: 'ocr_failed' };
  }

  const candidates: MatchCandidate[] = listOpenCandidates(db, zcaGroupId).map((row) => ({
    id: row.id,
    referenceText: row.reference_text,
    createdAt: row.created_at,
  }));
  const threshold = getTaskproofSetting('ocr_match_threshold', db);
  const winner = pickBestMatch(ocrText, candidates, threshold);
  if (!winner) {
    return { outcome: 'discarded', reason: 'below_threshold' };
  }

  const existing = findExistingSubmission(db, winner.candidate.id, uidFrom);
  const submissionId = existing?.id || newId();
  const storedPath = writeProofFile(proofDir, winner.candidate.id, submissionId, downloaded.buffer);
  upsertSubmission(db, {
    id: submissionId,
    taskId: winner.candidate.id,
    uidFrom,
    displayName: image.displayName || uidFrom,
    imageUrl: downloaded.sourceUrl,
    storedPath,
    matchScore: winner.result.score,
    createdAt: now(),
  });

  const closed = closeTaskIfQuotaReached(db, winner.candidate.id);
  const taskRow = db
    .prepare(`SELECT short_code FROM tasks WHERE id = ?`)
    .get(winner.candidate.id) as { short_code: string } | undefined;

  if (closed) {
    console.log(
      `[TaskProofWorker] Task ${taskRow?.short_code || winner.candidate.id} đủ quota → completed.`
    );
  }

  return {
    outcome: 'recorded',
    taskId: winner.candidate.id,
    shortCode: taskRow?.short_code,
    submissionId,
    storedPath,
    score: winner.result.score,
    closed,
  };
}
