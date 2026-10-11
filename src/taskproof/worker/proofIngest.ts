/**
 * proofIngest.ts
 *
 * Hàng đợi minh chứng: pre-filter → tải bytes → SIFT + lưới xám với ảnh mẫu
 * của từng task mở → ghi file + submissions → đóng khi đủ quota.
 *
 * Lỗi chấm ảnh hoặc task chưa có ảnh mẫu: chưa claim, có thể thử lại.
 * Ảnh FAIL: claim, không row, không đổi task.
 * UNIQUE(task_id, uid_from) ghi đè lần nộp trước, trừ ảnh mẫu (proof_origin=sample).
 * Worker không sendPhoto (T6 = official bot); đủ quota thì HTTP kick report-now.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getProofDir } from '../env';
import { closeTaskIfQuotaReached } from '../records/lifecycle';
import { getTaskproofExcludeUids } from '../records/settings';
import { shouldScoreZcaGroup } from './groupMap';
import { downloadProofBytes } from './imageFetch';
import { ImageMatchCandidate, ImageScore, pickBestImageMatch, ScoreImagePair } from './imageMatch';
import { observeMember, stripMemberId } from './memberCache';
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
  scoreImages?: ScoreImagePair;
  downloadImage?: (url: string) => Promise<Buffer | null>;
  loadSession?: () => ZcaCredentials | null;
  proofDir?: string;
  newId?: () => string;
  /** Official bot gửi T6; worker không sendPhoto. */
  kickReport?: (taskId: string) => Promise<unknown>;
  excludeUids?: Set<string>;
}

/** /quet: chỉ chấm một task, cho phép ảnh đã processed dưới ngưỡng. */
export interface ProofIngestOptions {
  onlyTaskId?: string;
  ignoreProcessed?: boolean;
  skipIfAlreadySubmitted?: boolean;
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
  reference_path: string;
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

const REFERENCE_PATH_SQL = `
  COALESCE(
    NULLIF(t.sample_stored_path, ''),
    (
      SELECT s.stored_path FROM submissions s
      WHERE s.task_id = t.id AND s.proof_origin = 'sample'
        AND IFNULL(s.stored_path, '') != ''
      ORDER BY s.created_at ASC
      LIMIT 1
    )
  )`;

function listOpenCandidates(
  db: Database.Database,
  zcaGroupId: string,
  onlyTaskId?: string
): OpenTaskRow[] {
  const taskFilter = onlyTaskId ? 't.id = ? AND t.zca_group_id = ?' : 't.zca_group_id = ?';
  const params = onlyTaskId ? [onlyTaskId, zcaGroupId] : [zcaGroupId];
  return db
    .prepare(
      `SELECT id, short_code, created_at, reference_path FROM (
         SELECT t.id, t.short_code, t.created_at, ${REFERENCE_PATH_SQL} AS reference_path
         FROM tasks t
         WHERE ${taskFilter} AND t.status IN ('collecting', 'overdue')
       )
       WHERE IFNULL(reference_path, '') != ''
       ORDER BY created_at ASC, id ASC`
    )
    .all(...params) as OpenTaskRow[];
}

function submissionsHaveOrigin(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all() as Array<{ name: string }>;
  return cols.some((col) => col.name === 'proof_origin');
}

function findExistingSubmission(
  db: Database.Database,
  taskId: string,
  uidFrom: string
): { id: string; stored_path: string | null; proof_origin?: string } | undefined {
  const clean = stripMemberId(uidFrom);
  const origin = submissionsHaveOrigin(db) ? ', proof_origin' : '';
  return db
    .prepare(
      `SELECT id, stored_path${origin} FROM submissions
       WHERE task_id = ? AND (uid_from = ? OR uid_from = ?)`
    )
    .get(taskId, uidFrom, clean) as
    | { id: string; stored_path: string | null; proof_origin?: string }
    | undefined;
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
  deps: ProofIngestDeps = {},
  opts: ProofIngestOptions = {}
): Promise<ProofIngestResult> {
  const now = deps.now ?? Date.now;
  const proofDir = deps.proofDir ?? getProofDir();
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const zcaGroupId = (image.threadId || '').trim();
  const msgId = (image.msgId || '').trim();
  const uidFrom = (image.uidFrom || '').trim();
  if (!zcaGroupId || !msgId || !uidFrom || uidFrom === '0') {
    return { outcome: 'skipped', reason: 'missing_ids' };
  }
  const cleanUid = stripMemberId(uidFrom);
  const excludeUids = deps.excludeUids ?? getTaskproofExcludeUids(db);
  if (excludeUids.has(uidFrom) || excludeUids.has(cleanUid)) {
    console.log(`[TaskProofWorker] Bỏ qua ảnh từ tài khoản bot/loại trừ msg=${msgId} uid=${uidFrom}`);
    return { outcome: 'skipped', reason: 'excluded_sender' };
  }
  observeMember(db, zcaGroupId, uidFrom, image.displayName || uidFrom, now());
  if (!shouldScoreZcaGroup(db, zcaGroupId)) {
    return { outcome: 'skipped', reason: 'unmapped_or_closed' };
  }
  if (opts.onlyTaskId && listOpenCandidates(db, zcaGroupId, opts.onlyTaskId).length === 0) {
    return { outcome: 'skipped', reason: 'task_not_open' };
  }
  if (opts.skipIfAlreadySubmitted && opts.onlyTaskId && findExistingSubmission(db, opts.onlyTaskId, uidFrom)) {
    return { outcome: 'skipped', reason: 'already_submitted' };
  }
  if (!opts.ignoreProcessed && alreadyProcessed(db, zcaGroupId, msgId)) {
    return { outcome: 'skipped', reason: 'already_processed' };
  }

  const session = deps.loadSession ? deps.loadSession() : loadSession();
  const downloaded = await downloadProofBytes(image.href, image.thumb, {
    session,
    download: deps.downloadImage,
  });
  if (!downloaded) {
    console.warn(
      `[TaskProofWorker] Tải minh chứng thất bại msg=${msgId} group=${zcaGroupId}`
    );
    return { outcome: 'discarded', reason: 'fetch_failed' };
  }

  const candidates: ImageMatchCandidate[] = listOpenCandidates(db, zcaGroupId, opts.onlyTaskId)
    .filter((row) => fs.existsSync(row.reference_path))
    .map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      referencePath: row.reference_path,
    }));
  if (candidates.length === 0) {
    console.warn(
      `[TaskProofWorker] Không có ảnh mẫu để chấm msg=${msgId} group=${zcaGroupId}`
    );
    return { outcome: 'discarded', reason: 'no_reference' };
  }

  let winner: { candidate: ImageMatchCandidate; result: ImageScore } | null;
  try {
    winner = await pickBestImageMatch(downloaded.buffer, candidates, deps.scoreImages);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[TaskProofWorker] Chấm ảnh lỗi (chưa claim, có thể thử lại):', msg);
    return { outcome: 'discarded', reason: 'image_match_failed' };
  }
  if (!winner) {
    const claimed = claimProcessedMessage(db, zcaGroupId, msgId, now());
    if (!opts.ignoreProcessed && !claimed) {
      return { outcome: 'skipped', reason: 'already_processed' };
    }
    console.log(
      `[TaskProofWorker] Ảnh không khớp mẫu msg=${msgId} bytes=${downloaded.buffer.length}`
    );
    return { outcome: 'discarded', reason: 'below_threshold' };
  }

  const existing = findExistingSubmission(db, winner.candidate.id, uidFrom);
  if (existing?.proof_origin === 'sample') {
    claimProcessedMessage(db, zcaGroupId, msgId, now());
    console.log(
      `[TaskProofWorker] Giữ ảnh mẫu, bỏ qua ảnh sau msg=${msgId} uid=${uidFrom}`
    );
    return { outcome: 'skipped', reason: 'already_submitted' };
  }
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
  claimProcessedMessage(db, zcaGroupId, msgId, now());

  const closed = closeTaskIfQuotaReached(db, winner.candidate.id);
  const taskRow = db
    .prepare(`SELECT short_code FROM tasks WHERE id = ?`)
    .get(winner.candidate.id) as { short_code: string } | undefined;
  console.log(
    `[TaskProofWorker] Ghi minh chứng ${taskRow?.short_code || winner.candidate.id} score=${winner.result.score} uid=${uidFrom} bytes=${downloaded.buffer.length}`
  );

  if (closed) {
    console.log(
      `[TaskProofWorker] Task ${taskRow?.short_code || winner.candidate.id} đủ quota → completed.`
    );
    const kick = deps.kickReport;
    if (kick) {
      void Promise.resolve(kick(winner.candidate.id)).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[TaskProofWorker] kick báo cáo ${taskRow?.short_code || winner.candidate.id} lỗi:`,
          msg
        );
      });
    }
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
