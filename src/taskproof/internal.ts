/**
 * internal.ts
 *
 * Router HTTP nội bộ phía official bot (Section 10).
 * Worker gọi localhost; Zalo fetch QR/file bằng ?key= (không gửi header).
 * sendPhoto chỉ nhận URL https — không đưa đường dẫn đĩa.
 */

import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { ZaloClient } from '../core/zaloClient';
import { getDatabase } from '../store';
import { rejectIfInvalidInternalKey } from './internalAuth';
import { notifyAdminWorkerDown } from './notifyAdmin';
import { getQrTmpDir } from './env';
import { formatScanResultReply, ScanHistorySummary } from './quet';
import { kickTaskCompletionReport, reportUnreportedCompletedTasks, TaskReportResult } from './report';
import { getTaskproofSetting } from './settings';

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface TaskproofInternalDeps {
  sendPhoto?: (chatId: string, photoUrl: string, caption?: string) => Promise<unknown>;
  sendMessage?: (chatId: string, text: string) => Promise<unknown>;
  getAdminChatId?: () => string;
  getQrTmpDir?: () => string;
  lookupStoredPath?: (submissionId: string) => string | null;
  reportNow?: (taskId?: string) => Promise<TaskReportResult[]>;
}

function defaultSendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<unknown> {
  return new ZaloClient().sendPhoto(chatId, photoUrl, caption);
}

function defaultSendMessage(chatId: string, text: string): Promise<unknown> {
  return new ZaloClient().sendMessage(chatId, text);
}

function defaultAdminChatId(): string {
  return getTaskproofSetting('admin_official_chat_id') || '';
}

function defaultLookupStoredPath(submissionId: string): string | null {
  try {
    const row = getDatabase()
      .prepare(`SELECT stored_path FROM submissions WHERE id = ?`)
      .get(submissionId) as { stored_path: string | null } | undefined;
    return row?.stored_path || null;
  } catch {
    return null;
  }
}

function sendFileOr404(res: Response, filePath: string, contentType: string): void {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.status(404).json({ success: false, error: 'not_found' });
    return;
  }
  const buf = fs.readFileSync(path.resolve(filePath));
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

export function createTaskproofInternalRouter(deps: TaskproofInternalDeps = {}): Router {
  const router = Router();
  const sendPhoto = deps.sendPhoto ?? defaultSendPhoto;
  const sendMessage = deps.sendMessage ?? defaultSendMessage;
  const getAdminChatId = deps.getAdminChatId ?? defaultAdminChatId;
  const qrDir = deps.getQrTmpDir ?? getQrTmpDir;
  const lookupStoredPath = deps.lookupStoredPath ?? defaultLookupStoredPath;
  const reportNow =
    deps.reportNow ??
    ((taskId?: string) =>
      taskId
        ? kickTaskCompletionReport(taskId)
        : reportUnreportedCompletedTasks());

  router.post('/internal/taskproof/worker-down', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const code = typeof req.body?.code === 'number' ? req.body.code : null;
    const signal = typeof req.body?.signal === 'string' ? req.body.signal : null;
    const result = await notifyAdminWorkerDown({ code, signal });
    res.json({ success: true, ...result });
  });

  /**
   * Worker đã ghi PNG tạm; bot gửi URL https tới admin (không chờ webhook).
   */
  router.post('/internal/taskproof/deliver-qr', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const expiresAt = typeof req.body?.expires_at === 'number' ? req.body.expires_at : null;
    if (!imageUrl) {
      res.status(400).json({ success: false, error: 'image_url is required' });
      return;
    }
    const adminChatId = getAdminChatId();
    if (!adminChatId) {
      res.status(409).json({
        success: false,
        state: 'login_failed',
        error: 'admin_official_chat_id is empty',
      });
      return;
    }
    try {
      await sendPhoto(adminChatId, imageUrl, 'Quét QR để đăng nhập tài khoản thu thập minh chứng (zca-js).');
      res.json({ success: true, delivered: true, expires_at: expiresAt });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] deliver-qr sendPhoto thất bại:', msg);
      res.status(409).json({ success: false, state: 'login_failed', error: msg });
    }
  });

  router.post('/internal/taskproof/login-result', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const ok = req.body?.ok === true;
    const error = typeof req.body?.error === 'string' ? req.body.error : '';
    const adminChatId = getAdminChatId();
    const text = ok
      ? 'Đăng nhập zca-js thành công. Worker sẵn sàng thu thập minh chứng.'
      : `Đăng nhập zca-js thất bại${error ? `: ${error}` : ''}. Gõ lại /task, /nhac, /quet hoặc /lienket để thử QR mới.`;
    if (!adminChatId) {
      console.warn('[TaskProof] login-result: chưa có admin_official_chat_id, chỉ ghi log.');
      res.json({ success: true, sent: false, reason: 'missing_admin_chat_id' });
      return;
    }
    try {
      await sendMessage(adminChatId, text);
      res.json({ success: true, sent: true, ok });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] login-result sendMessage thất bại:', msg);
      res.json({ success: true, sent: false, reason: msg });
    }
  });

  /**
   * Worker vừa đóng quota — gửi báo cáo ngay, không chờ cron phút.
   * Cron /internal/run-due-jobs vẫn là lớp dự phòng.
   */
  router.post('/internal/taskproof/report-now', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id.trim() : '';
    try {
      const reports = await reportNow(taskId || undefined);
      res.json({
        success: true,
        reports: reports.map((row) => ({
          task_id: row.taskId,
          short_code: row.shortCode,
          reported: row.reported,
          destination: row.destination,
          photos_sent: row.photosSent,
          photos_skipped: row.photosSkipped,
          error: row.error,
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] report-now lỗi:', msg);
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/internal/taskproof/scan-result', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const replyChatId =
      typeof req.body?.reply_chat_id === 'string' ? req.body.reply_chat_id.trim() : '';
    if (!replyChatId) {
      res.status(400).json({ success: false, error: 'reply_chat_id is required' });
      return;
    }
    const summary: ScanHistorySummary = {
      shortCode: typeof req.body?.short_code === 'string' ? req.body.short_code : '',
      count: typeof req.body?.count === 'number' ? req.body.count : 0,
      scanned: typeof req.body?.scanned === 'number' ? req.body.scanned : 0,
      recorded: typeof req.body?.recorded === 'number' ? req.body.recorded : 0,
      skipped: typeof req.body?.skipped === 'number' ? req.body.skipped : 0,
      discarded: typeof req.body?.discarded === 'number' ? req.body.discarded : 0,
      closed: req.body?.closed === true,
      truncated: req.body?.truncated === true,
      error: typeof req.body?.error === 'string' ? req.body.error : undefined,
    };
    const text = formatScanResultReply(summary);
    try {
      await sendMessage(replyChatId, text);
      res.json({ success: true, sent: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] scan-result sendMessage thất bại:', msg);
      res.json({ success: true, sent: false, reason: msg });
    }
  });

  router.post('/internal/taskproof/link-result', async (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const officialChatId =
      typeof req.body?.official_chat_id === 'string' ? req.body.official_chat_id.trim() : '';
    if (!officialChatId) {
      res.status(400).json({ success: false, error: 'official_chat_id is required' });
      return;
    }
    const ok = req.body?.ok === true;
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name : '';
    const error = typeof req.body?.error === 'string' ? req.body.error : '';
    const text = ok
      ? `Đã liên kết: ${displayName || req.body?.zca_group_id || officialChatId}`
      : `Liên kết nhóm thất bại${error ? `: ${error}` : ''}. Gõ /lienket để thử lại.`;
    try {
      await sendMessage(officialChatId, text);
      res.json({ success: true, sent: true, ok });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskProof] link-result sendMessage thất bại:', msg);
      res.json({ success: true, sent: false, reason: msg });
    }
  });

  router.get('/internal/taskproof/qr/:id', (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!id || !SAFE_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    sendFileOr404(res, path.join(qrDir(), `${id}.png`), 'image/png');
  });

  router.get('/internal/taskproof/file/:submission_id', (req: Request, res: Response) => {
    if (rejectIfInvalidInternalKey(req, res)) return;
    const id = typeof req.params.submission_id === 'string' ? req.params.submission_id : '';
    if (!id || !SAFE_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const storedPath = lookupStoredPath(id);
    sendFileOr404(res, storedPath || '', 'image/jpeg');
  });

  return router;
}

export const taskproofInternalRouter = createTaskproofInternalRouter();
